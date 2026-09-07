/**
 * Customer self-service "modify my booking" — change party size / date / time
 * on an existing reservation and settle the price difference through Stripe.
 *
 * Money model (mirrors how GetYourGuide settles a change):
 *   - Reserve-now-pay-later, not yet charged → the amount Stripe will later
 *     charge is simply updated to the new total. No immediate payment.
 *   - Fully paid & new total LOWER → the difference is refunded immediately to
 *     the original payment method (partial Stripe refund tagged
 *     `reason: booking_modify` so the webhook never mis-ranks the booking).
 *   - Fully paid & new total HIGHER → the change is PARKED as a BookingChange
 *     (status PENDING_PAYMENT) with a server-minted PaymentIntent for the delta
 *     only; the payment_intent.succeeded webhook finalizes it atomically.
 *     Abandoned top-ups are cancelled by an expiry sweep and leave the booking
 *     untouched.
 *
 * BookingChange is the audit + money ledger: one APPLIED row records previous
 * vs updated snapshots, the signed delta, and (for top-ups) the PaymentIntent.
 *
 * Safety rails (all enforced server-side, re-checked inside the write lock):
 *   - Only the owner can modify; CONFIRMED or an uncharged PENDING pay-later.
 *   - Start-time-aware cutoff (default mirrors the cancellation window, 24h);
 *     all-sales-final / changesAllowed:false tours are locked out.
 *   - Booking must still be payout-PENDING and outside any payout request.
 *   - Capacity is re-validated EXCLUDING this booking's own travellers.
 */

const prisma = require('./prismaClient');
const getConfig = require('./getConfig');
const AppError = require('./appError');
const { evaluateModifyPolicy, modificationCutoffHours, activityStart } = require('./bookingHelpers');
const { calculateTourPrice } = require('./tourHelpers');
const { evaluateBookingAvailability, travelerCount, parseBlob, toDateKey } = require('./availabilityCore');
const { validatePassengerMix } = require('./passengerMix');
const {
  calculateCommission,
  createRefund,
  getStripe,
  ensureStripeCustomer,
} = require('./stripeHelpers');
const { enqueueEmail, enqueueNotification } = require('./queue');
const { notifyAdmin } = require('./adminNotificationService');

// Non-numeric metadata keys carried inside the travelers JSON blob.
const TRAVELER_META_KEYS = ['phoneNumber', 'location', 'details'];

const TOPUP_TTL_MINUTES = 30;
const TOPUP_GRACE_MINUTES = 10;

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function parseDateInput(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  const normalized = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  const d = new Date(`${normalized}T00:00:00.000Z`);
  return Number.isFinite(d.getTime()) ? d : null;
}

function travelDateKey(date) {
  return toDateKey(date);
}

/** Numeric traveler-count map (ignores phoneNumber/location/details). */
function countMap(travelers) {
  const out = {};
  if (travelers && typeof travelers === 'object') {
    for (const [key, value] of Object.entries(travelers)) {
      if (TRAVELER_META_KEYS.includes(key)) continue;
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0) out[key] = value;
    }
  }
  return out;
}

function countsEqual(a, b) {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => a[k] === b[k]);
}

function mergeTravelers(original, requested) {
  const meta = {};
  if (original && typeof original === 'object') {
    for (const key of TRAVELER_META_KEYS) {
      if (key in original) meta[key] = original[key];
    }
  }
  const merged = { ...countMap(original) };
  const requestCounts = countMap(requested || {});
  for (const [key, value] of Object.entries(requestCounts)) {
    if (typeof value === 'number' && Number.isInteger(value)) {
      merged[key] = Math.min(50, Math.max(0, value));
    }
  }
  // Traveller detail rows beyond the new headcount are dropped (tail); rows are
  // keyed by category then position, so trimming the tail never drops the lead.
  const total = travelerCount(merged);
  const details = Array.isArray(meta.details) ? meta.details : [];
  if (details.length > total) meta.details = details.slice(0, total);
  return { ...meta, ...merged };
}

/** Start time (naive UTC) for a target date/time — shared cutoff anchor. */
function targetStart(date, time) {
  const d = date instanceof Date ? date : new Date(date);
  let ms = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (typeof time === 'string' && /^\d{1,2}:\d{2}/.test(time)) {
    const [h, m] = time.split(':').map((n) => parseInt(n, 10) || 0);
    ms += (h * 60 + m) * 60 * 1000;
  }
  return new Date(ms);
}

function humanDate(date) {
  if (!date) return '—';
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return '—';
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function asDate(value) {
  return value instanceof Date ? value : new Date(value);
}

/** Build the change-summary list for emails. */
function buildChangeLabels(prev, next) {
  const labels = [];
  const prevDate = asDate(prev.travelDate);
  const nextDate = asDate(next.travelDate);
  if (Number.isFinite(prevDate.getTime()) && Number.isFinite(nextDate.getTime()) && travelDateKey(prevDate) !== travelDateKey(nextDate)) {
    labels.push({ label: 'Activity date', detail: `${humanDate(prevDate)} → ${humanDate(nextDate)}` });
  }
  if ((prev.selectedTime || null) !== (next.selectedTime || null)) {
    labels.push({ label: 'Start time', detail: `${prev.selectedTime || 'Not set'} → ${next.selectedTime || 'Not set'}` });
  }
  if (prev.travelerTotal !== next.travelerTotal) {
    labels.push({ label: 'Travellers', detail: `${prev.travelerTotal} → ${next.travelerTotal}` });
  }
  return labels;
}

/**
 * Server-side build of the target booking from a validated request body.
 * Counts merge over the existing category mix (only the provided categories
 * change); meta keys (phone/location) and traveller details are preserved.
 */
function buildTarget(booking, body) {
  const rawDate = parseDateInput(body.travelDate);
  const date = rawDate || new Date(booking.travelDate);
  const hasDate = !!rawDate;

  const hasTime = Object.prototype.hasOwnProperty.call(body, 'selectedTime');
  const time = hasTime ? (body.selectedTime ? String(body.selectedTime) : null) : (booking.selectedTime || null);

  const hasParty = !!body.travelers && typeof body.travelers === 'object';
  const travelers = hasParty
    ? mergeTravelers(booking.travelers || {}, body.travelers)
    : (booking.travelers || {});

  const travelerTotal = travelerCount(travelers);
  if (travelerTotal < 1) {
    throw new AppError('At least one traveller is required', 400);
  }

  const dateChanged = travelDateKey(date) !== travelDateKey(new Date(booking.travelDate));
  const timeChanged = (time || null) !== (booking.selectedTime || null);
  const partyChanged = hasParty && !countsEqual(countMap(booking.travelers), countMap(travelers));

  if (!dateChanged && !timeChanged && !partyChanged) {
    throw new AppError('No changes were requested', 400);
  }

  return { dateChanged, timeChanged, partyChanged, date, time, travelers, travelerTotal };
}

/** Eligibility gate shared by quote + apply (throws on ineligible). */
function assertModifyEligible(booking) {
  const policy = evaluateModifyPolicy(booking, booking.tour);
  if (!policy.allowed) throw new AppError(policy.reason, 400);
  if (booking.payoutStatus && booking.payoutStatus !== 'PENDING') {
    throw new AppError('This booking can no longer be changed once payout has begun', 409);
  }
  return policy;
}

/** Money settlement classification for the current booking state. */
function settlementMode(booking, delta) {
  if (booking.paymentStatus === 'SUCCEEDED') {
    if (delta > 0) return { kind: 'topup', delta };
    if (delta < 0) return { kind: 'refund', delta };
    return { kind: 'none', delta };
  }
  if (
    booking.paymentStatus === 'PENDING' &&
    booking.paymentTiming === 'later' &&
    booking.stripePaymentIntentId
  ) {
    return { kind: 'paylater-update', delta };
  }
  throw new AppError('This booking cannot be changed in its current payment state', 409);
}

/**
 * Recompute the financial snapshot for a modification. Runs passenger-mix and
 * target-cutoff checks and derives every stored money column (subtotal,
 * grossAmount, discount, commission + supplier payout) from the SAME engines a
 * new booking uses, at the CURRENT live price.
 *
 * @param {object} ctx { booking, tour, target, customerId }
 * @returns {object} { previous, next, delta, kind, moneyMode, target, changes, policy }
 */
async function computeSnapshot(ctx) {
  const { booking, tour, target, customerId } = ctx;
  const policy = evaluateModifyPolicy(booking, tour);
  if (!policy.allowed) throw new AppError(policy.reason, 400);

  const parsed = parseBlob(tour.schedulesAndPricing) || {};
  const mix = validatePassengerMix(parsed, target.travelers);
  if (!mix.ok) throw new AppError(mix.errors[0], 400);

  const cutoffHours = modificationCutoffHours(booking, tour);
  const start = targetStart(target.date, target.time);
  const hoursUntil = (start - new Date()) / (60 * 60 * 1000);
  if (!Number.isFinite(hoursUntil) || hoursUntil < cutoffHours) {
    throw new AppError(
      `Changes must be made at least ${cutoffHours} hour${cutoffHours === 1 ? '' : 's'} before the new start time`,
      400
    );
  }
  const maxAdvanceDays = parseInt(await getConfig('booking.max_advance_days', '365'), 10);
  if (hoursUntil / 24 > maxAdvanceDays) {
    throw new AppError(`Changes can only be made up to ${maxAdvanceDays} days before the activity`, 400);
  }

  const pricing = await calculateTourPrice(
    tour,
    target.travelers,
    target.date,
    target.time || null,
    null,
    customerId,
    null
  );
  if (!pricing || pricing.success === false) {
    throw new AppError((pricing && pricing.error) || 'Unable to calculate pricing for the change', 400);
  }
  const newTotal = round2(pricing.total);
  if (!Number.isFinite(newTotal) || newTotal <= 0) {
    throw new AppError('Unable to price the requested change', 400);
  }

  const supplierProfile = tour.supplier?.supplierProfile || {};
  const commission = await calculateCommission(newTotal, supplierProfile);

  const previous = {
    travelDate: new Date(booking.travelDate),
    selectedTime: booking.selectedTime || null,
    travelers: booking.travelers || {},
    travelerTotal: travelerCount(booking.travelers),
    subtotal: round2(booking.subtotal || 0),
    discount: round2(booking.discounts || 0),
    grossAmount: round2(booking.grossAmount),
    platformCommission: round2(booking.platformCommission || 0),
    supplierPayout: round2(booking.supplierPayout || 0),
  };

  const next = {
    travelDate: new Date(target.date),
    selectedTime: target.time || null,
    travelers: target.travelers,
    travelerTotal: target.travelerTotal,
    subtotal: round2(pricing.subtotal),
    discount: round2(pricing.discount || 0),
    newTotal,
    platformCommission: round2(commission.amount),
    supplierPayout: round2(commission.supplierPayout),
  };

  const delta = round2(newTotal - previous.grossAmount);
  const moneyMode = settlementMode(booking, delta);
  const kind = target.dateChanged && target.partyChanged
    ? 'MODIFY_BOTH'
    : target.dateChanged
      ? 'MODIFY_DATE'
      : 'MODIFY_PARTY';

  const changes = buildChangeLabels(previous, { ...next, travelDate: next.travelDate });

  return {
    previous,
    next,
    delta,
    moneyMode,
    kind,
    changes,
    target,
    policy,
  };
}

/** Authoritative capacity re-check excluding this booking's own travellers. */
async function validateTargetCapacity(tx, tour, target, bookingId) {
  const result = await evaluateBookingAvailability(
    tx,
    tour,
    travelDateKey(target.date),
    target.time || null,
    target.travelers,
    { excludeBookingId: bookingId }
  );
  if (!result.ok) throw new AppError(result.reason, 409);
  return result;
}

async function loadOwnedBooking(bookingId, customerId, source) {
  return prisma.booking.findFirst({
    where: { id: bookingId, customerId, source, status: { in: ['PENDING', 'CONFIRMED'] } },
    include: { tour: { include: { supplier: { include: { supplierProfile: true } } } } },
  });
}

/**
 * Read-only quote for the modify page (and eligibility gating).
 */
async function quoteBookingModification({ bookingId, customerId, source, body }) {
  const booking = await loadOwnedBooking(bookingId, customerId, source);
  if (!booking) throw new AppError('Booking not found or cannot be modified', 404);
  const policy = assertModifyEligible(booking);

  const target = buildTarget(booking, body || {});
  const snapshot = await computeSnapshot({ booking, tour: booking.tour, target, customerId });
  const capacity = await validateTargetCapacity(prisma, booking.tour, target, booking.id);

  return {
    bookingId: booking.id,
    bookingNumber: booking.bookingNumber,
    allowed: true,
    policy: {
      allowed: true,
      cutoffHours: policy.cutoffHours,
      deadline: policy.deadline ? policy.deadline.toISOString() : null,
    },
    current: {
      travelDate: travelDateKey(new Date(booking.travelDate)),
      selectedTime: booking.selectedTime || null,
      travelerTotal: travelerCount(booking.travelers),
      travelers: booking.travelers || {},
      grossAmount: round2(booking.grossAmount),
    },
    quote: {
      travelDate: travelDateKey(snapshot.target.date),
      selectedTime: snapshot.target.time,
      travelers: snapshot.target.travelers,
      travelerTotal: snapshot.target.travelerTotal,
      subtotal: snapshot.next.subtotal,
      discount: snapshot.next.discount,
      previousTotal: snapshot.previous.grossAmount,
      newTotal: snapshot.next.newTotal,
      delta: snapshot.delta,
      currency: booking.currency || 'USD',
      moneyMode: snapshot.moneyMode.kind,
      changes: snapshot.changes,
      capacity: {
        availableSpots: capacity.availableSpots,
        groupsRemaining: capacity.groupsRemaining,
      },
    },
  };
}

/** Most recent actionable parked change for a booking, if any. */
async function activeParkedChange(bookingId) {
  return prisma.bookingChange.findFirst({
    where: { bookingId, status: 'PENDING_PAYMENT' },
    orderBy: { createdAt: 'desc' },
  });
}

/** Cancel an abandoned parked change's PaymentIntent + mark it terminal. */
async function settleParkedChange(change, terminalStatus) {
  const allowed = ['DISCARDED', 'EXPIRED'];
  if (!allowed.includes(terminalStatus)) throw new AppError('Invalid terminal state', 500);
  if (!change || change.status !== 'PENDING_PAYMENT') return { ok: false, reason: 'no_pending_change' };

  if (change.paymentIntentId) {
    try {
      const pi = await getStripe().paymentIntents.retrieve(change.paymentIntentId);
      if (pi.status === 'succeeded') {
        // Payment landed before we could cancel — let the webhook/sweep apply it.
        return { ok: false, reason: 'payment_already_succeeded', status: 'PENDING_PAYMENT' };
      }
      if (!['canceled', 'succeeded'].includes(pi.status)) {
        await getStripe().paymentIntents.cancel(change.paymentIntentId);
      }
    } catch (err) {
      throw new AppError(`Could not cancel the pending payment: ${err.message}`, 502);
    }
  }

  await prisma.bookingChange.update({
    where: { id: change.id },
    data: { status: terminalStatus },
  });
  return { ok: true };
}

/**
 * Park a paid-booking increase and mint the top-up PaymentIntent for the delta.
 * The booking is NOT mutated here — the webhook applies it only after payment.
 */
async function parkTopUpChange({ booking, snapshot, customerId, user }) {
  const expiresAt = new Date(Date.now() + TOPUP_TTL_MINUTES * 60 * 1000);

  // One parked change at a time — clear any previous pending one.
  const previousParked = await activeParkedChange(booking.id);
  if (previousParked) {
    const outcome = await settleParkedChange(previousParked, 'DISCARDED');
    if (!outcome.ok && outcome.reason === 'payment_already_succeeded') {
      throw new AppError('A previous change payment is being processed — try again shortly', 409);
    }
  }

  const change = await prisma.bookingChange.create({
    data: {
      bookingId: booking.id,
      changedBy: 'customer',
      kind: snapshot.kind,
      status: 'PENDING_PAYMENT',
      delta: snapshot.delta,
      expiresAt,
      previous: snapshot.previous,
      updated: { ...snapshot.next, delta: snapshot.delta },
    },
  });

  const deltaCents = Math.round(snapshot.delta * 100);
  let stripeCustomerId = null;
  if (user && user.id) {
    stripeCustomerId = await ensureStripeCustomer(user);
  }
  const intent = await getStripe().paymentIntents.create({
    amount: deltaCents,
    currency: String(booking.currency || 'USD').toLowerCase(),
    automatic_payment_methods: { enabled: true },
    ...(stripeCustomerId ? { customer: stripeCustomerId } : {}),
    metadata: {
      action: 'booking-topup',
      bookingId: booking.id,
      changeId: change.id,
      source: String(booking.source || 'expedition').toLowerCase(),
    },
  });

  await prisma.bookingChange.update({
    where: { id: change.id },
    data: { paymentIntentId: intent.id },
  });

  return {
    changeId: change.id,
    status: 'PENDING_PAYMENT',
    expiresAt: expiresAt.toISOString(),
    payment: {
      paymentIntentId: intent.id,
      clientSecret: intent.client_secret,
      amount: deltaCents,
      currency: booking.currency || 'USD',
      expiresAt: expiresAt.toISOString(),
    },
    money: { previousTotal: snapshot.previous.grossAmount, newTotal: snapshot.next.newTotal, delta: snapshot.delta },
  };
}

/** "Travellers: 1 → 2 · Activity date: Sep 9 → Sep 12" — which fields changed. */
function changeSummaryText(changes) {
  const list = Array.isArray(changes) ? changes : [];
  if (list.length === 0) return 'booking details';
  return list
    .map((c) => {
      if (c && typeof c === 'object' && c.label) {
        return c.detail ? `${c.label}: ${c.detail}` : c.label;
      }
      return String(c || '');
    })
    .filter(Boolean)
    .join(' · ');
}

/** Send the "booking has been updated" emails + supplier/admin notifications. */
async function notifyModificationApplied(bookingId, payload) {
  const data = payload || {};
  const booking = await prisma.booking
    .findUnique({ where: { id: bookingId }, include: { tour: { select: { supplierId: true, title: true } } } })
    .catch(() => null);
  if (!booking) return;

  const changes = Array.isArray(data.changes) ? data.changes : [];
  const summary = changeSummaryText(changes);
  const sharedData = {
    bookingId: booking.id,
    source: String(booking.source || '').toLowerCase(),
    changes,
    changeSummary: summary,
    previousTotal: data.previousTotal,
    newTotal: data.newTotal,
    adjustment: data.adjustment,
  };

  enqueueEmail({
    type: 'customer-booking-changed',
    bookingId,
    data: {
      changes,
      previousTotal: data.previousTotal,
      adjustment: data.adjustment,
      newTotal: data.newTotal,
    },
  }).catch((err) => console.error('[BookingModify] customer-booking-changed email failed:', err.message));

  enqueueEmail({
    type: 'supplier-booking-changed',
    bookingId,
    data: {
      changes,
      previousPayout: data.previousPayout,
      newPayout: data.newPayout,
      payoutAdjustment: data.payoutAdjustment,
    },
  }).catch((err) => console.error('[BookingModify] supplier-booking-changed email failed:', err.message));

  if (booking.tour?.supplierId) {
    enqueueNotification({
      userId: booking.tour.supplierId,
      type: 'BOOKING_MODIFIED',
      title: 'Booking Updated',
      message: `Booking #${booking.bookingNumber} was updated — ${summary}`,
      data: sharedData,
    }).catch((err) =>
      console.error('[BookingModify] supplier BOOKING_MODIFIED notification failed:', err.message)
    );
  }

  // Ops visibility: a confirmed booking's party/date/total changed post-payment,
  // so finance + support can spot it on the booking without digging through logs.
  notifyAdmin({
    type: 'BOOKING_MODIFIED',
    title: 'Booking Modified by Customer',
    message: `Booking #${booking.bookingNumber}${booking.tour?.title ? ` for "${booking.tour.title}"` : ''} was updated — ${summary}`,
    data: sharedData,
  }).catch((err) => console.error('[BookingModify] admin BOOKING_MODIFIED notification failed:', err.message));
}

/**
 * Apply a modification that needs NO additional payment:
 *   - fully paid and total stays the same or goes down (refund difference),
 *   - reserve-now-pay-later not yet charged (amount updates instead).
 * Runs under a tour row lock with an authoritative capacity re-check.
 */
async function applyBookingModification({ bookingId, customerId, source, body, user }) {
  const booking = await loadOwnedBooking(bookingId, customerId, source);
  if (!booking) throw new AppError('Booking not found or cannot be modified', 404);
  assertModifyEligible(booking);

  const target = buildTarget(booking, body);
  // Compute BEFORE any payment work so we know which settlement branch we are on.
  const snapshot = await computeSnapshot({ booking, tour: booking.tour, target, customerId });

  if (snapshot.moneyMode.kind === 'topup') {
    return parkTopUpChange({ booking, snapshot, customerId, user });
  }

  // Reserve-now-pay-later amount update happens BEFORE the DB transaction with
  // compensation on failure so Stripe and our stored total can never diverge.
  let previousPiAmount = null;
  if (snapshot.moneyMode.kind === 'paylater-update' && snapshot.delta !== 0) {
    try {
      const pi = await getStripe().paymentIntents.retrieve(booking.stripePaymentIntentId);
      previousPiAmount = pi.amount;
      if (pi.status === 'requires_confirmation' || pi.status === 'requires_payment_method') {
        await getStripe().paymentIntents.update(booking.stripePaymentIntentId, {
          amount: Math.round(snapshot.next.newTotal * 100),
        });
      }
    } catch (err) {
      throw new AppError(`Could not update the reserved payment amount: ${err.message}`, 502);
    }
  }

  let committed;
  try {
    committed = await prisma.$transaction(async (tx) => {
      // Serialization point — lock the tour row exactly like booking creation.
      const [locked] = await tx.$queryRawUnsafe('SELECT id FROM "Tour" WHERE id = $1 FOR UPDATE', booking.tourId);
      if (!locked) throw new Error('Tour not found');

      const tourRecord = await tx.tour.findUnique({
        where: { id: booking.tourId },
        include: { supplier: { include: { supplierProfile: true } } },
      });
      if (!tourRecord) throw new Error('Tour not found');

      // Re-read the booking under the lock and re-verify nothing changed while
      // the quote was on screen (status, payout, totals).
      const lockedBooking = await tx.booking.findUnique({ where: { id: booking.id } });
      if (!lockedBooking || !['PENDING', 'CONFIRMED'].includes(lockedBooking.status)) {
        throw new AppError('Booking is no longer modifiable', 409);
      }
      if (lockedBooking.payoutStatus && lockedBooking.payoutStatus !== 'PENDING') {
        throw new AppError('This booking can no longer be changed once payout has begun', 409);
      }
      const verifyPolicy = evaluateModifyPolicy(
        { ...lockedBooking, tour: tourRecord },
        tourRecord
      );
      if (!verifyPolicy.allowed) throw new AppError(verifyPolicy.reason, 409);
      // Fresh snapshot against the locked tour + locked booking row.
      const lockedSnapshot = await computeSnapshot({
        booking: lockedBooking,
        tour: tourRecord,
        target,
        customerId,
      });
      if (lockedSnapshot.moneyMode.kind === 'topup') {
        throw new AppError('This booking now requires an additional payment — please retry', 409);
      }
      if (lockedSnapshot.delta !== snapshot.delta) {
        // Price changed under us — quote is stale, tell the user to retry.
        throw new AppError('The tour price changed — please review the updated quote', 409);
      }

      await validateTargetCapacity(tx, tourRecord, target, booking.id);

      const travelerDelta =
        lockedSnapshot.next.travelerTotal - lockedSnapshot.previous.travelerTotal;

      const updated = await tx.booking.update({
        where: { id: booking.id },
        data: {
          travelDate: lockedSnapshot.next.travelDate,
          selectedTime: lockedSnapshot.next.selectedTime,
          travelers: lockedSnapshot.next.travelers,
          subtotal: lockedSnapshot.next.subtotal,
          discounts: lockedSnapshot.next.discount,
          grossAmount: lockedSnapshot.next.newTotal,
          commissionRate: round2(lockedSnapshot.next.platformCommission / Math.max(1, lockedSnapshot.next.newTotal)),
          platformCommission: lockedSnapshot.next.platformCommission,
          supplierPayout: lockedSnapshot.next.supplierPayout,
        },
      });

      // Keep applied special-offer spotsSold in sync with the headcount.
      if (booking.appliedOfferId && travelerDelta !== 0) {
        await tx.specialOffer.update({
          where: { id: booking.appliedOfferId },
          data: { spotsSold: { increment: travelerDelta } },
        }).catch(() => {});
      }

      await tx.bookingChange.create({
        data: {
          bookingId: booking.id,
          changedBy: 'customer',
          kind: lockedSnapshot.kind,
          status: 'APPLIED',
          delta: lockedSnapshot.delta,
          appliedAt: new Date(),
          previous: lockedSnapshot.previous,
          updated: { ...lockedSnapshot.next, delta: lockedSnapshot.delta },
        },
      });

      return { booking: updated, snapshot: lockedSnapshot };
    });
  } catch (err) {
    // Compensate the PI amount update if the DB commit failed.
    if (previousPiAmount !== null && booking.stripePaymentIntentId) {
      getStripe().paymentIntents.update(booking.stripePaymentIntentId, { amount: previousPiAmount })
        .catch((revertErr) => console.error('[BookingModify] Could not revert reserved PI amount:', revertErr.message));
    }
    throw err;
  }

  const snapshotData = committed.snapshot;

  // Partial refund of the difference (after commit, mirroring the cancel flow).
  if (snapshotData.moneyMode.kind === 'refund') {
    const refundCents = Math.round(Math.abs(snapshotData.delta) * 100);
    try {
      await createRefund(booking.stripePaymentIntentId, refundCents, {
        metadata: { reason: 'booking_modify', bookingId: booking.id },
      });
    } catch (err) {
      console.error(`[BookingModify] Partial refund failed for booking ${booking.id}:`, err.message);
    }
  }

  notifyModificationApplied(booking.id, {
    changes: snapshotData.changes,
    previousTotal: snapshotData.previous.grossAmount,
    newTotal: snapshotData.next.newTotal,
    adjustment: snapshotData.delta,
    previousPayout: snapshotData.previous.supplierPayout,
    newPayout: snapshotData.next.supplierPayout,
    payoutAdjustment: round2(snapshotData.next.supplierPayout - snapshotData.previous.supplierPayout),
  });

  return {
    bookingId: booking.id,
    status: 'APPLIED',
    bookingNumber: booking.bookingNumber,
    money: {
      mode: snapshotData.moneyMode.kind,
      previousTotal: snapshotData.previous.grossAmount,
      newTotal: snapshotData.next.newTotal,
      delta: snapshotData.delta,
      currency: booking.currency || 'USD',
    },
    quote: {
      travelDate: travelDateKey(snapshotData.next.travelDate),
      selectedTime: snapshotData.next.selectedTime,
      travelerTotal: snapshotData.next.travelerTotal,
      travelers: snapshotData.next.travelers,
    },
  };
}

/**
 * Finalize a parked top-up inside an open transaction (webhook path). Applies
 * the change from the parked snapshot only after re-verifying capacity, mix and
 * that the booking row still matches the parked `previous` snapshot.
 *
 * @returns {{ applied: boolean, refundRequired: boolean, bookingId?, reason? }}
 */
async function finalizeTopUpChangeInTx(tx, change, intent) {
  if (!change || change.status !== 'PENDING_PAYMENT') return { applied: false, refundRequired: false };

  const failWithRefund = async (reason) => {
    await tx.bookingChange.update({
      where: { id: change.id },
      data: { status: 'FAILED', updatedAt: new Date() },
    }).catch(() => {});
    return { applied: false, refundRequired: true, reason };
  };

  // Lock the tour row (serialization point) then re-read everything under it.
  const baseBooking = await tx.booking.findUnique({
    where: { id: change.bookingId },
    select: { tourId: true, status: true },
  });
  if (!baseBooking || !['PENDING', 'CONFIRMED'].includes(baseBooking.status)) {
    return failWithRefund('booking_unavailable');
  }
  const [locked] = await tx.$queryRawUnsafe('SELECT id FROM "Tour" WHERE id = $1 FOR UPDATE', baseBooking.tourId);
  if (!locked) return failWithRefund('tour_not_found');

  const tourRecord = await tx.tour.findUnique({
    where: { id: baseBooking.tourId },
    include: { supplier: { include: { supplierProfile: true } } },
  });
  const booking = await tx.booking.findUnique({ where: { id: change.bookingId } });
  if (!booking || !['PENDING', 'CONFIRMED'].includes(booking.status)) {
    return failWithRefund('booking_unavailable');
  }
  if (booking.payoutStatus && booking.payoutStatus !== 'PENDING') {
    return failWithRefund('payout_started');
  }

  const prev = change.previous || {};
  const next = change.updated || {};
  if (round2(prev.grossAmount) !== round2(booking.grossAmount)) {
    return failWithRefund('quote_stale');
  }

  const target = {
    date: new Date(next.travelDate || change.booking.travelDate),
    time: next.selectedTime || null,
    travelers: next.travelers || change.booking.travelers,
    travelerTotal: travelerCount(next.travelers || change.booking.travelers),
    dateChanged: travelDateKey(next.travelDate || change.booking.travelDate) !== travelDateKey(new Date(booking.travelDate)),
    timeChanged: (next.selectedTime || null) !== (booking.selectedTime || null),
    partyChanged: true,
  };

  if (intent && Math.round(round2(change.delta || 0) * 100) !== intent.amount) {
    return failWithRefund('amount_mismatch');
  }

  const parsed = parseBlob(tourRecord.schedulesAndPricing) || {};
  const mix = validatePassengerMix(parsed, target.travelers);
  if (!mix.ok) return failWithRefund(mix.errors[0]);

  const capacity = await evaluateBookingAvailability(
    tx,
    tourRecord,
    travelDateKey(target.date),
    target.time || null,
    target.travelers,
    { excludeBookingId: change.bookingId }
  );
  if (!capacity.ok) return failWithRefund('capacity_lost');

  const travelerDelta = target.travelerTotal - travelerCount(booking.travelers);

  await tx.booking.update({
    where: { id: change.bookingId },
    data: {
      travelDate: new Date(next.travelDate || change.booking.travelDate),
      selectedTime: next.selectedTime || null,
      travelers: next.travelers,
      subtotal: round2(next.subtotal ?? 0),
      discounts: round2(next.discount ?? 0),
      grossAmount: round2(next.newTotal),
      commissionRate: round2(round2(next.platformCommission ?? 0) / Math.max(1, round2(next.newTotal))),
      platformCommission: round2(next.platformCommission ?? 0),
      supplierPayout: round2(next.supplierPayout ?? 0),
    },
  });

  if (booking.appliedOfferId && travelerDelta !== 0) {
    await tx.specialOffer.update({
      where: { id: booking.appliedOfferId },
      data: { spotsSold: { increment: travelerDelta } },
    }).catch(() => {});
  }

  await tx.bookingChange.update({
    where: { id: change.id },
    data: { status: 'APPLIED', appliedAt: new Date(), updatedAt: new Date() },
  });

  return {
    applied: true,
    refundRequired: false,
    bookingId: change.bookingId,
    payload: {
      changes: buildChangeLabels(prev, next),
      previousTotal: round2(prev.grossAmount),
      newTotal: round2(next.newTotal),
      adjustment: round2(change.delta || 0),
      previousPayout: round2(prev.supplierPayout),
      newPayout: round2(next.supplierPayout),
      payoutAdjustment: round2(round2(next.supplierPayout) - round2(prev.supplierPayout)),
    },
  };
}

/** Discard a pending top-up the customer no longer wants. */
async function discardParkedChange({ changeId, customerId }) {
  const change = await prisma.bookingChange.findUnique({
    where: { id: changeId },
    include: { booking: { select: { customerId: true } } },
  });
  if (!change || change.booking?.customerId !== customerId) {
    throw new AppError('Pending change not found', 404);
  }
  const outcome = await settleParkedChange(change, 'DISCARDED');
  if (!outcome.ok && outcome.reason === 'payment_already_succeeded') {
    return { status: 'PAYMENT_COMPLETED_PENDING_APPLY', changeId: change.id };
  }
  if (!outcome.ok && outcome.reason === 'no_pending_change') {
    throw new AppError('There is no pending change to discard', 409);
  }
  return { status: 'DISCARDED', changeId: change.id };
}

/** Sweep — expire abandoned top-up payments (checkout-hold cadence). */
async function expireModifyTopUps() {
  const graceCutoff = new Date(Date.now() - (TOPUP_TTL_MINUTES + TOPUP_GRACE_MINUTES) * 60 * 1000);
  const stale = await prisma.bookingChange.findMany({
    where: { status: 'PENDING_PAYMENT', expiresAt: { lt: graceCutoff } },
    take: 50,
    orderBy: { createdAt: 'asc' },
  });

  let expired = 0;
  let finalized = 0;
  for (const change of stale) {
    if (!change.paymentIntentId) {
      await prisma.bookingChange.update({ where: { id: change.id }, data: { status: 'EXPIRED' } });
      expired += 1;
      continue;
    }
    let pi;
    try {
      pi = await getStripe().paymentIntents.retrieve(change.paymentIntentId);
    } catch (err) {
      console.error('[BookingModify] Could not retrieve top-up PI', change.paymentIntentId, err.message);
      continue;
    }
    if (pi.status === 'succeeded') {
      // Webhook never landed — apply now (same path, own transaction).
      const result = await finalizeTopUpChangeStandalone(change.id);
      if (result.applied) finalized += 1;
      continue;
    }
    try {
      if (pi.status !== 'canceled') await getStripe().paymentIntents.cancel(change.paymentIntentId);
      await prisma.bookingChange.update({ where: { id: change.id }, data: { status: 'EXPIRED' } });
      expired += 1;
    } catch (err) {
      console.error('[BookingModify] Expiry sweep could not cancel PI', change.paymentIntentId, err.message);
    }
  }
  return { stale: stale.length, expired, finalized };
}

/** Standalone finalize (sweep path, no enclosing webhook transaction). */
async function finalizeTopUpChangeStandalone(changeId) {
  const change = await prisma.bookingChange.findUnique({ where: { id: changeId } });
  if (!change || change.status !== 'PENDING_PAYMENT') return { applied: false };
  let outcome;
  try {
    outcome = await prisma.$transaction(async (tx) => finalizeTopUpChangeInTx(tx, change, null));
  } catch (err) {
    console.error('[BookingModify] Standalone finalize failed', changeId, err.message);
    return { applied: false };
  }
  if (outcome.applied && outcome.payload) {
    notifyModificationApplied(change.bookingId, outcome.payload).catch(() => {});
  }
  if (outcome.refundRequired && change.paymentIntentId) {
    createRefund(change.paymentIntentId)
      .then((refund) => {
        console.log(`[BookingModify] Auto-refunded failed top-up ${change.paymentIntentId}: ${refund.id}`);
        enqueueEmail({
          type: 'refund-completed',
          bookingId: change.bookingId,
          data: { refundReference: refund.id, refundedAt: new Date().toISOString() },
        }).catch(() => {});
      })
      .catch((err) => console.error('[BookingModify] Top-up auto-refund failed', err.message));
  }
  return outcome;
}

/**
 * List the PaymentIntents that hold captured funds for a booking, oldest first.
 * Used by cancellation so a full refund is spread across the original charge
 * and any top-up intents instead of over-refunding the primary one.
 */
async function paymentSourceIntents(booking) {
  const sources = [];
  if (booking && booking.stripePaymentIntentId) {
    sources.push({ paymentIntentId: booking.stripePaymentIntentId, primary: true });
  }
  if (booking && booking.id) {
    const topUps = await prisma.bookingChange.findMany({
      where: { bookingId: booking.id, status: 'APPLIED', paymentIntentId: { not: null } },
      select: { paymentIntentId: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const t of topUps) {
      if (t.paymentIntentId && !sources.some((s) => s.paymentIntentId === t.paymentIntentId)) {
        sources.push({ paymentIntentId: t.paymentIntentId, primary: false });
      }
    }
  }
  return sources;
}

/**
 * Refund `refundCents` across every captured PaymentIntent for the booking,
 * most recent capture first. Returns true when the full amount was refunded.
 */
async function refundAcrossSources(booking, refundCents) {
  const sources = await paymentSourceIntents(booking);
  let remaining = refundCents;
  for (const source of sources) {
    if (remaining <= 0) break;
    let captured = null;
    try {
      const pi = await getStripe().paymentIntents.retrieve(source.paymentIntentId);
      captured = Number(pi.amount_captured) || Number(pi.amount) || 0;
    } catch { /* treat as unknown */ }
    if (captured === null) continue;
    const toRefund = Math.min(captured, remaining);
    if (toRefund <= 0) continue;
    await createRefund(source.paymentIntentId, toRefund, {
      metadata: source.primary
        ? { reason: 'booking_cancel', bookingId: booking.id }
        : { reason: 'booking_modify', bookingId: booking.id },
    });
    remaining -= toRefund;
  }
  return remaining <= 0;
}

module.exports = {
  quoteBookingModification,
  applyBookingModification,
  discardParkedChange,
  activeParkedChange,
  finalizeTopUpChangeInTx,
  finalizeTopUpChangeStandalone,
  expireModifyTopUps,
  notifyModificationApplied,
  refundAcrossSources,
  paymentSourceIntents,
  assertModifyEligible,
  buildTarget,
  computeSnapshot,
  mergeTravelers,
  TOPUP_TTL_MINUTES,
};
