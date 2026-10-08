const prisma = require('./prismaClient');
const { evaluateBookingAvailability, travelerCount, parseBlob } = require('./availabilityCore');
const { generateBookingNumber } = require('./bookingHelpers');
const { resolvePickupSelection, normalizePickupSnapshot } = require('./geoUtils');

const HOLD_MINUTES = parseInt(process.env.CHECKOUT_HOLD_MINUTES, 10) || 30;

/**
 * Acquire an atomic seat hold for a pay-now checkout.
 *
 * Runs inside a serializable transaction that locks the Tour row (same
 * serialization point used by every other write path). The hold occupies
 * capacity via `evaluateBookingAvailability` (hold-aware) so no concurrent
 * checkout can oversell the same seats.
 *
 * Returns { ok: true, draftId, expiresAt } on success.
 * Returns { ok: false, reason } when capacity is unavailable or the customer
 * already has an active hold for the same slot.
 */
async function acquireHold({
  customerId,
  tourId,
  tour,
  travelDate,
  selectedTime,
  travelers,
  payload,
  pricing,
  commission,
  source,
  bookingPrefix,
  clientOrigin,
  optionId,
  optionScope,
}) {
  const seats = travelerCount(travelers);

  // Multi-option: resolve the option's id/title + capacity scope. When no
  // option is passed, optId/scope stay null (legacy whole-tour behavior).
  const tourOpts = require('./tourOptions');
  let optId = null;
  let optTitle = null;
  let scope = optionScope || null;
  if (optionId && tour) {
    const resolved = tourOpts.resolveTourOption(tour, optionId);
    optId = resolved.option && resolved.option.id ? resolved.option.id : optionId;
    optTitle = resolved.option ? resolved.option.title || null : null;
    scope = tourOpts.optionScopeFor(tour, optionId) || scope;
  }

  // Resolve the brand once, from the booking source, BEFORE anything is
  // written. The booking prefix must follow from the source — a hardcoded
  // default here is exactly how one storefront's prefix ends up on another
  // storefront's bookings when a caller forgets to pass one.
  const { BRANDS } = require('../../../config/brands');
  const brand =
    Object.values(BRANDS).find((b) => b.source === (source || 'EXPEDITION')) || BRANDS.expedition;

  const draft = await prisma.$transaction(async (tx) => {
    // ── Serialize on the tour row (same lock used by confirmBooking,
    //    override writes, and delete checks). ──────────────────────
    const [locked] = await tx.$queryRawUnsafe(
      `SELECT id FROM "Tour" WHERE id = $1 FOR UPDATE`,
      tourId
    );
    if (!locked) throw new Error('Tour not found');

    // ── Capacity check: bookings + other active holds (option-scoped) ──
    const evalResult = await evaluateBookingAvailability(
      tx, tour, travelDate, selectedTime, travelers,
      scope ? { optionScope: scope } : {}
    );
    if (!evalResult.ok) throw new Error(evalResult.reason);

    // ── Pickup fail-fast: reject an invalid non-deferred selection before a
    //    hold is created, so a bad pickup never gets to the webhook. ──────
    if (payload && payload.pickup && typeof payload.pickup === 'object') {
      const pickupResult = resolvePickupSelection(
        payload.pickup,
        parseBlob(tour.bookingAndTickets) || {}
      );
      if (!pickupResult.ok) throw new Error(pickupResult.error);
    }

    // ── Dedup: one active hold per customer per slot ─────────────
    const existing = await tx.checkoutDraft.findFirst({
      where: {
        customerId,
        tourId,
        travelDate: new Date(travelDate),
        ...(selectedTime ? { selectedTime } : {}),
        status: 'HOLDING',
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    if (existing) {
      throw new Error('You already have an active checkout for this tour on this date');
    }

    const commissionRate = commission.rate;
    const platformCommission = commission.amount;
    const supplierPayout = commission.supplierPayout;

    return tx.checkoutDraft.create({
      data: {
        customerId,
        tourId,
        travelDate: new Date(travelDate),
        selectedTime: selectedTime || null,
        seats,
        optionId: optId,
        payload: {
          ...(payload ?? {}),
          _source: source || 'EXPEDITION',
          _bookingPrefix: bookingPrefix || brand.bookingPrefix,
          _clientOrigin: clientOrigin || null,
          ...(optId ? { _optionId: optId, _optionTitle: optTitle } : {}),
        },
        pricing: pricing ?? {},
        commissionRate,
        platformCommission,
        supplierPayout,
        currency: pricing.currency || 'USD',
        expiresAt: new Date(Date.now() + HOLD_MINUTES * 60 * 1000),
        status: 'HOLDING',
      },
    });
  });

  // ── Analytics: the customer started checkout ──────────────────────────
  // The live flow has no cart step, so "checkout started" is the meaningful
  // mid-funnel signal (it also covers the abandoned-checkout drop-off).
  // Written DIRECTLY via eventEmitter (not the queue): hold acquisition is
  // low-volume and queue drops previously removed every `checkout_started`
  // event from the Event table, making the admin funnel show 0.
  try {
    const event = require('./eventEmitter');
    // `brand` was resolved above from the same source — reuse it rather than
    // repeating the lookup, so analytics and the stored prefix cannot diverge.
    event.emit({
      name: `${brand.eventNamespace}.checkout_started`,
      userId: customerId,
      resource: 'Tour',
      resourceId: tourId,
      properties: { tourId, total: pricing?.total ?? null, currency: pricing?.currency || 'USD', source: brand.key },
    });
  } catch { /* analytics is best-effort */ }

  return { ok: true, draftId: draft.id, expiresAt: draft.expiresAt };
}

/**
 * Release a hold (mark EXPIRED). Safe to call on holds that are already
 * expired or paid — idempotent by status guard.
 */
async function releaseHold(draftId, reason = 'expired') {
  const updated = await prisma.checkoutDraft.updateMany({
    where: { id: draftId, status: 'HOLDING' },
    data: { status: reason === 'refunded' ? 'REFUNDED' : 'EXPIRED' },
  });
  return updated.count > 0;
}

/**
 * Materialize a hold into a real Booking. Called by the
 * checkout.session.completed webhook.
 *
 * Guarantees:
 *  - Tour is locked FOR UPDATE (serialization point).
 *  - The hold is still status='HOLDING' (guarded updateMany + idempotent).
 *  - Session amount matches the frozen pricing snapshot.
 *  - Capacity is re-verified EXCLUDING the own hold (the hold may count
 *    against capacity that has since shrunk via override writes).
 *    If capacity vanished: release hold, return { ok: false, reason } so
 *    the caller can collect the PI for auto-refund.
 */
async function materializeHold(draftId, session, paymentIntentId) {
  let createdBooking = null;
  let oversold = false;

  const draft = await prisma.$transaction(async (tx) => {
    // ── Load draft (guarded: only HOLDING) ─────────────────────
    const draftRecord = await tx.checkoutDraft.findUnique({ where: { id: draftId } });
    if (!draftRecord || draftRecord.status !== 'HOLDING') {
      return null; // Already materialized / expired — idempotent no-op
    }

    // Read source/prefix from draft payload (set by acquireHold). The prefix is
    // never hardcoded here: if a draft predates `_bookingPrefix` or a caller
    // omitted it, derive it from the draft's OWN source so the booking is
    // minted under the storefront that took the payment — not under whichever
    // brand the original author happened to have in mind when writing the
    // default. This is the path that used to produce EXP- numbers on Ghana
    // bookings.
    const { BRANDS } = require('../../../config/brands');
    const source = draftRecord.payload?._source || 'EXPEDITION';
    const brand = Object.values(BRANDS).find((b) => b.source === source) || BRANDS.expedition;
    const bookingPrefix = draftRecord.payload?._bookingPrefix || brand.bookingPrefix;

    // ── Lock the tour ──────────────────────────────────────────
    const [locked] = await tx.$queryRawUnsafe(
      `SELECT id FROM "Tour" WHERE id = $1 FOR UPDATE`,
      draftRecord.tourId
    );
    if (!locked) throw new Error('Tour not found');

    // ── Amount guard ───────────────────────────────────────────
    const expectedCents = Math.round(Number(draftRecord.pricing.total) * 100);
    if (session.amount_total && session.amount_total !== expectedCents) {
      throw new Error(`Amount mismatch: expected ${expectedCents}, got ${session.amount_total}`);
    }

    // ── Capacity re-check: exclude this hold ───────────────────
    // The hold already reserved seats, but if a supplier shrunk capacity
    // during the hold window the booking would exceed the new ceiling.
    const tourRecord = await tx.tour.findUnique({
      where: { id: draftRecord.tourId },
      include: { supplier: { include: { supplierProfile: true } } },
    });

    // Multi-option hold: resolve the option title + capacity scope so the
    // materialization capacity re-check and the created booking both know it.
    let materializedOptionId = draftRecord.optionId || null;
    let materializedOptionTitle = null;
    let materializedScope = null;
    if (draftRecord.optionId) {
      const tourOpts = require('./tourOptions');
      const resolved = tourOpts.resolveTourOption(tourRecord, draftRecord.optionId);
      materializedOptionId = resolved.option && resolved.option.id ? resolved.option.id : draftRecord.optionId;
      materializedOptionTitle = resolved.option ? resolved.option.title || null : (draftRecord.payload?._optionTitle || null);
      materializedScope = tourOpts.optionScopeFor(tourRecord, draftRecord.optionId) || null;
    } else if (draftRecord.payload?._optionId) {
      materializedOptionId = draftRecord.payload._optionId;
      materializedOptionTitle = draftRecord.payload._optionTitle || null;
    }
    const evalResult = await evaluateBookingAvailability(
      tx, tourRecord, draftRecord.travelDate, draftRecord.selectedTime,
      draftRecord.payload.travelers,
      {
        excludeDraftId: draftId,
        ...(materializedScope ? { optionScope: materializedScope } : {}),
      }
    );
    if (!evalResult.ok) {
      // Capacity gone — release hold, return false so caller refunds.
      await tx.checkoutDraft.update({
        where: { id: draftId },
        data: { status: 'EXPIRED' },
      });
      oversold = true;
      return null;
    }

    // ── Create the Booking ─────────────────────────────────────
    const bookingNumber = await generateBookingNumber(bookingPrefix);
    // Resolve + normalize the pickup snapshot through the SAME canonical path
    // as pay-later (resolvePickupSelection) — not the raw client payload — so
    // "pickup later" always carries pickupLater/status and invalid selections
    // can never be stored. Degrades to `deferred` if the config changed.
    const pickupSnapshot = normalizePickupSnapshot(
      draftRecord.payload.pickup || null,
      parseBlob(tourRecord.bookingAndTickets) || {}
    );
    const booking = await tx.booking.create({
      data: {
        bookingNumber,
        customerId: draftRecord.customerId,
        tourId: draftRecord.tourId,
        source,
        ...(materializedOptionId ? { optionId: materializedOptionId, optionTitle: materializedOptionTitle } : {}),
        clientOrigin: draftRecord.payload?._clientOrigin || null,
        status: 'CONFIRMED',
        paymentStatus: 'SUCCEEDED',
        paidAt: new Date(),
        travelers: draftRecord.payload.travelers,
        travelDate: draftRecord.travelDate,
        selectedTime: draftRecord.selectedTime || null,
        leadTravelerName: draftRecord.payload.leadTraveler?.name || null,
        leadTravelerEmail: draftRecord.payload.leadTraveler?.email || null,
        leadTravelerPhone: draftRecord.payload.leadTraveler?.phone || null,
        specialRequests: draftRecord.payload.specialRequests || '',
        pickup: pickupSnapshot || null,
        subtotal: draftRecord.pricing.subtotal,
        grossAmount: draftRecord.pricing.total,
        discounts: draftRecord.pricing.discount || 0,
        currency: draftRecord.pricing.currency,
        commissionRate: draftRecord.commissionRate,
        platformCommission: draftRecord.platformCommission,
        supplierPayout: draftRecord.supplierPayout,
        stripePaymentIntentId: paymentIntentId || null,
        stripeCheckoutSessionId: session.id || null,
        paymentTiming: 'now',
        appliedOfferId: draftRecord.pricing?.appliedOffer?.id || null,
        offerName: draftRecord.pricing?.appliedOffer?.name || null,
        offerPromoCode: draftRecord.pricing?.appliedOffer?.promoCode || null,
        offerDiscountType: draftRecord.pricing?.appliedOffer?.discountType || null,
        offerDiscountPct: draftRecord.pricing?.appliedOffer?.discountPercentage || null,
        offerDiscountFix: draftRecord.pricing?.appliedOffer?.fixedDiscountValue || null,
      },
      include: {
        tour: { select: { id: true, title: true, slug: true, coverPhoto: true, supplierId: true } },
        customer: { select: { id: true, name: true, email: true } },
      },
    });

    // ── Mark draft PAID ────────────────────────────────────────
    await tx.checkoutDraft.update({
      where: { id: draftId },
      data: { status: 'PAID', bookingId: booking.id },
    });

    // ── Clean up any cart items ─────────────────────────────────
    await tx.cartItem.deleteMany({
      where: {
        customerId: draftRecord.customerId,
        tourId: draftRecord.tourId,
        selectedDate: draftRecord.travelDate,
      },
    }).catch(() => {});

    createdBooking = booking;
    return draftRecord;
  });

  if (!draft) {
    return { ok: false, reason: oversold ? 'sold_out' : 'already_settled', oversold };
  }

  // ── Analytics: record the completed booking for the conversion funnel ──
  // The pay-now path materializes the Booking here (from the Stripe webhook),
  // not in the request that started checkout, so this is the only place the
  // completion step can be recorded. Brand comes off the draft payload.
  // Written directly via eventEmitter (see the checkout_started note above).
  try {
    const event = require('./eventEmitter');
    const { BRANDS } = require('../../../config/brands');
    const brandSource = draft.payload?._source || 'EXPEDITION';
    const brand = Object.values(BRANDS).find((b) => b.source === brandSource) || BRANDS.expedition;
    event.emit({
      name: `${brand.eventNamespace}.booking_reserved`,
      userId: createdBooking.customerId,
      resource: 'Booking',
      resourceId: createdBooking.id,
      properties: {
        tourId: createdBooking.tourId,
        total: createdBooking.grossAmount,
        currency: createdBooking.currency,
        paymentTiming: 'now',
        source: brand.key,
      },
    });
  } catch { /* analytics is best-effort */ }

  // ── Supplier notification (after commit, fire-and-forget) ─────────────
  // Pay-now bookings never notified the supplier before; the draft carries the
  // platform so the message and data.source are correct for either storefront.
  try {
    const { enqueueNotification } = require('./queue');
    const isGhana = (draft.payload?._source || 'EXPEDITION') === 'GHANA';
    enqueueNotification({
      userId: createdBooking.tour.supplierId,
      type: 'BOOKING_CONFIRMED',
      title: isGhana ? 'New Travio Ghana Booking' : 'New Booking Received',
      message: isGhana
        ? `A new booking (${createdBooking.bookingNumber}) was made through Travio Ghana Tours for "${createdBooking.tour.title}"`
        : `You have a new booking for "${createdBooking.tour.title}"`,
      data: { bookingId: createdBooking.id, source: isGhana ? 'ghana' : 'expedition' },
    }).catch(() => {});
  } catch { /* notification is best-effort */ }

  return { ok: true, booking: createdBooking, oversold: false };
}

module.exports = { acquireHold, releaseHold, materializeHold, HOLD_MINUTES };
