/**
 * Supplier-created bookings — a supplier recording a booking for a customer,
 * including a walk-in who has never registered, and reporting money collected
 * outside the platform (cash, mobile money, bank transfer, a card taken on
 * their own terminal).
 *
 * This module deliberately REUSES every existing engine:
 *   pricing        tourHelpers.calculateTourPrice (the only pricing engine)
 *   commission     commissionLedger (rate frozen on the booking, charged on
 *                  money actually collected — see that module for the rules)
 *   availability   availabilityCore.evaluateBookingAvailability, inside a
 *                  transaction that has locked the tour row
 *   charges        SupplierCharge — the same OPEN-charge ledger the
 *                  cancellation fee uses, netted off the next payout
 *   numbers        bookingHelpers.generateBookingNumber
 *
 * It does NOT create a second pricing engine, a second availability engine or
 * a second settlement ledger. The rules that make the money trustworthy:
 *
 *  - `paymentStatus` is never touched. It means what the PLATFORM's processor
 *    did. Money a supplier says they collected is recorded in
 *    BookingCollection — a different fact, on purpose.
 *  - `payoutStatus` is never advanced. The supplier already holds this money;
 *    paying it out again would pay them twice.
 *  - COMMISSION FOLLOWS MONEY ACTUALLY COLLECTED: an OPEN SupplierCharge is
 *    raised on EVERY collection, positive or negative, linked to the collection
 *    row that raised it. Never on an unpaid reservation. The rate and policy
 *    are frozen on the booking at creation and never re-read from config.
 *  - NO CREDIT: a collection is only accepted when the supplier's available
 *    balance (eligible unpaid earnings − open charges) covers the commission
 *    it raises, checked under a per-supplier lock so two concurrent events
 *    cannot both claim the same balance.
 *  - `platformCommission` / `supplierPayout` are the MARKETPLACE settlement
 *    snapshot. A supplier-created booking never settles through that pipeline,
 *    so they carry 0 and the gross — the charge ledger is the only
 *    authoritative commission figure for these rows.
 *  - CREATION IS ONE TRANSACTION with the tour row locked; availability is
 *    re-checked inside it, so two suppliers cannot oversell the last seat.
 *  - CREATION IS IDEMPOTENT: the same key + same request replays the original
 *    booking; the same key + a different request is a conflict. A retry after
 *    a commit can never produce a second booking or a second charge.
 *  - NOTHING EXTERNAL runs inside the transaction. Notifications go out after
 *    commit through the existing queue.
 */

const prisma = require('./prismaClient');
const crypto = require('crypto');
const AppError = require('./appError');
const getConfig = require('./getConfig');
const { calculateTourPrice, } = require('./tourHelpers');
const { calculateCommission } = require('./stripeHelpers');
const { evaluateBookingAvailability } = require('./availabilityCore');
const { applyOption } = require('./tourOptions');
const { generateBookingNumber } = require('./bookingHelpers');
const { logActivity } = require('./auditLogger');
const { enqueueEmail, enqueueNotification } = require('./queue');
const logger = require('./logger');
const {
  round2,
  policyFor: frozenPolicyFor,
  configuredPolicy,
  commissionFor,
  coverBalance,
  assertCover,
  raiseCollectionCommission,
  reverseCollectionCommission,
  zeroBookingCommission,
  bookingCommission,
} = require('./commissionLedger');

const ORIGIN = 'SUPPLIER_CREATED';

/**
 * The feature is off until someone turns it on. The BACKEND enforces this —
 * hiding the button is not a control. Per-brand key, so Ghana can be live
 * while another brand is not.
 */
async function isFeatureEnabled(brandKey = 'ghana') {
  const raw = await getConfig(`feature.supplierCreatedBookings.${brandKey}`, 'false');
  return String(raw).toLowerCase() === 'true';
}

async function assertFeatureEnabled(brandKey) {
  if (!(await isFeatureEnabled(brandKey))) {
    throw new AppError('Supplier-created bookings are not enabled for this brand', 403);
  }
}

/**
 * Commission policy for supplier-created bookings, read from config. The
 * supplier never supplies this. `APPLY` charges the configured rate on money
 * collected; `WAIVE` records a deliberate, auditable waiver.
 *
 * Once a booking exists the policy is FROZEN on it (`Booking.commissionPolicy`)
 * — this reads config only for bookings that predate that column.
 */
async function commissionPolicy() {
  return configuredPolicy();
}

function canonicalHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** Availability evaluation wants the FULL tour row (schedules, options). */
async function loadTourForBooking(tx, tourId, supplierId) {
  // No `include`: `schedulesAndPricing` is a Json column, not a relation, and
  // every field the engines need comes back with the row itself.
  const tour = await tx.tour.findUnique({ where: { id: tourId } });
  if (!tour || tour.supplierId !== supplierId) {
    throw new AppError('Tour not found or not yours', 404);
  }
  return tour;
}

/**
 * Resolve the selected option the same way every other availability caller
 * does (tourOptions.applyOption): the projected engine blobs for pricing and
 * the capacity scope for the availability core. Passing the option KEY
 * straight through would be silently ignored — the core scopes on the
 * option's id.
 */
function resolveOption(tour, optionId) {
  const applied = optionId ? applyOption(tour, optionId) : { tour, optionScope: null, optionId: null };
  if (optionId && !applied.optionId) {
    throw new AppError('That tour option does not exist on this tour', 422);
  }
  return applied;
}

/**
 * Server-authoritative quote: price + an availability verdict, computed by the
 * same engines checkout uses. The client displays this and never submits a
 * total of its own.
 */
async function quoteBooking({ supplierId, brandKey, tourId, optionId, travelDate, selectedTime, travelers }) {
  await assertFeatureEnabled(brandKey);

  const tour = await loadTourForBooking(prisma, tourId, supplierId);
  const applied = resolveOption(tour, optionId);
  const dateKey = String(travelDate).slice(0, 10);

  // Price the option-projected tour: the engine reads the projected engine
  // blobs, while the selector still drives special-offer matching.
  const pricing = await calculateTourPrice(
    applied.tour,
    travelers,
    dateKey,
    selectedTime || null,
    optionId || null,
    null,
    null,
  );
  if (!pricing || pricing.success === false) {
    throw new AppError(pricing?.error || 'This tour cannot be priced for the selected date and party', 422);
  }

  const availability = await evaluateBookingAvailability(
    prisma,
    applied.tour,
    dateKey,
    selectedTime || null,
    travelers,
    applied.optionScope ? { optionScope: applied.optionScope } : {},
  );

  const commission = await calculateCommission(pricing.total);
  const policy = await commissionPolicy();
  const currency = pricing.currency || tour.schedulesAndPricing?.pricingSchedules?.currency || 'USD';
  const rate = policy === 'APPLY' ? commission.rate : 0;
  // The figure the drawer disables on and the create path enforces — one
  // rounding rule, so the preview can never disagree with the charge.
  const required = round2(rate * Number(pricing.total));

  // No credit: the commission must be covered by money the platform is
  // already holding for this supplier in this currency. This is the SAME
  // check `createBooking` runs under a lock — here it is only a preview, so
  // the button never appears enabled for a request the server would refuse.
  const balance = await coverBalance(supplierId);
  const line = balance[currency] || { available: 0, eligible: 0, openCharges: 0 };

  return {
    currency,
    subtotal: pricing.subtotal,
    discount: pricing.discount || 0,
    total: pricing.total,
    available: Boolean(availability.ok),
    unavailableReason: availability.ok ? null : availability.reason,
    commission: {
      policy,
      rate,
      amount: required,
    },
    cover: {
      currency,
      available: line.available,
      eligible: line.eligible,
      openCharges: line.openCharges,
      required,
      sufficient: line.available + 0.005 >= required,
      shortfall: line.available + 0.005 >= required ? 0 : round2(required - line.available),
    },
  };
}

/**
 * Create the booking. One transaction; nothing external inside it.
 */
async function createBooking({
  supplierId,
  actorId,
  brandKey,
  tourId,
  optionId,
  travelDate,
  selectedTime,
  travelers,
  guest,
  customerId,
  pickupAddress,
  pickupAreaName,
  specialRequests,
  collection,
  idempotencyKey,
}) {
  await assertFeatureEnabled(brandKey);

  if (!idempotencyKey || String(idempotencyKey).trim().length < 8) {
    throw new AppError('An idempotency key is required', 400);
  }
  if (customerId && guest) {
    throw new AppError('Provide either a registered customer or guest details, not both', 400);
  }
  if (!customerId && !guest?.name) {
    throw new AppError('Guest name is required for a walk-in booking', 400);
  }

  const requestHash = canonicalHash({
    tourId, optionId, travelDate, selectedTime, travelers,
    customerId: customerId || null, guest: guest || null,
    pickupAddress: pickupAddress || null, pickupAreaName: pickupAreaName || null,
    specialRequests: specialRequests || null,
    collection: collection || null,
  });

  const booking = await prisma.$transaction(async (tx) => {
    // 1. Claim the idempotency key FIRST, inside the same transaction: a
    //    concurrent duplicate loses the unique-constraint race and replays.
    const existing = await tx.bookingIdempotencyKey.findUnique({
      where: { supplierId_key: { supplierId, key: String(idempotencyKey) } },
    });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new AppError('This idempotency key was already used for a different request', 409);
      }
      if (existing.bookingId) {
        const prior = await tx.booking.findUnique({ where: { id: existing.bookingId } });
        if (prior) return prior; // replay: the original result, no second booking
      }
    }

    // 2. Lock the SUPPLIER row. The no-credit cover check below is a
    //    read-then-write on a balance other collections also change, so every
    //    money event for a supplier serialises here first. Lock order is
    //    always supplier → tour, so two concurrent creates cannot deadlock.
    const [lockedSupplier] = await tx.$queryRawUnsafe(
      'SELECT id FROM "User" WHERE id = $1 FOR UPDATE',
      supplierId,
    );
    if (!lockedSupplier) throw new AppError('Supplier not found', 404);

    // 3. Lock the tour row — the same lock the checkout path takes. Two
    //    concurrent creates for the last seat serialize here.
    const [lockedTour] = await tx.$queryRawUnsafe(
      'SELECT id FROM "Tour" WHERE id = $1 AND "supplierId" = $2 FOR UPDATE',
      tourId,
      supplierId,
    );
    if (!lockedTour) throw new AppError('Tour not found or not yours', 404);

    // 4. Authoritative availability inside the transaction.
    const tour = await loadTourForBooking(tx, tourId, supplierId);
    const applied = resolveOption(tour, optionId);
    const dateKey = String(travelDate).slice(0, 10);
    const availability = await evaluateBookingAvailability(
      tx, applied.tour, dateKey, selectedTime || null, travelers,
      applied.optionScope ? { optionScope: applied.optionScope } : {},
    );
    if (!availability.ok) {
      throw new AppError(availability.reason || 'No availability for that date', 409);
    }

    // 5. Authoritative price. Never the client's number. The projected tour
    //    (see resolveOption) is what the engine prices; the selector still
    //    drives special-offer matching.
    const pricing = await calculateTourPrice(applied.tour, travelers, dateKey, selectedTime || null, optionId || null, null, null);
    if (!pricing || pricing.success === false) {
      throw new AppError(pricing?.error || 'This tour cannot be priced for the selected date and party', 422);
    }

    // 6. An offline collection is money in hand, so it cannot exceed what the
    //    booking actually costs. `recordCollection` enforces the same ceiling
    //    for later reports; creation must not be a way around it.
    if (collection && Number(collection.amount) > 0) {
      const reported = Math.round(Number(collection.amount) * 100) / 100;
      const cost = Math.round(Number(pricing.total) * 100) / 100;
      if (!Number.isFinite(reported) || reported <= 0) {
        throw new AppError('A positive collection amount is required', 400);
      }
      if (reported > cost + 0.005) {
        throw new AppError(
          `That exceeds what the booking costs (${cost} ${pricing.currency || 'USD'})`,
          400,
        );
      }
    }

    // 7. Guest or registered customer. No fake users, no email matching.
    let guestId = null;
    if (!customerId) {
      const created = await tx.bookingGuest.create({
        data: {
          name: String(guest.name).trim().slice(0, 120),
          phone: guest.phone ? String(guest.phone).trim().slice(0, 40) : null,
          email: guest.email ? String(guest.email).trim().slice(0, 254) : null,
        },
      });
      guestId = created.id;
    }

    // 8. The booking. `origin` is set by the BACKEND; `source` keeps meaning
    //    which storefront this belongs to and is left to the caller's brand.
    const commission = await calculateCommission(pricing.total);
    const policy = await commissionPolicy();
    const currency = pricing.currency || 'USD';
    const frozenRate = policy === 'APPLY' ? commission.rate : 0;

    // NO CREDIT, and the authoritative gate. Required is the commission on the
    // FULL booking total, not on the initial collection: the supplier must be
    // able to collect the rest later without the balance failing them. Taken
    // under the supplier lock above, so concurrent creates cannot both pass.
    await assertCover({
      tx,
      supplierId,
      currency,
      required: round2(frozenRate * Number(pricing.total)),
      verb: 'create this booking',
    });

    // Passed `tx` on purpose: the counter increment joins THIS transaction, so
    // a rolled-back create burns no number and no second connection is opened.
    const bookingNumber = await generateBookingNumber(undefined, tx);
    const created = await tx.booking.create({
      data: {
        bookingNumber,
        origin: ORIGIN,
        customerId: customerId || null,
        guestId,
        tourId,
        // The option's id (not its key): per-option capacity and availability
        // lookups join on this column.
        optionId: applied.optionId || null,
        travelDate: new Date(dateKey),
        selectedTime: selectedTime || null,
        travelers,
        subtotal: pricing.subtotal,
        grossAmount: pricing.total,
        discounts: pricing.discount || 0,
        currency,
        // Commission is snapshotted from config, never from the client, and
        // frozen here — every later collection uses this rate and policy, so a
        // config change can never reprice this booking.
        commissionRate: frozenRate,
        commissionPolicy: policy,
        // The supplier already holds this money; the platform never collected
        // and will never pay it. `platformCommission` is the MARKETPLACE
        // settlement snapshot and would be a lie here — the charge ledger is
        // the authoritative commission figure for a supplier-created booking.
        platformCommission: 0,
        supplierPayout: pricing.total,
        specialRequests: specialRequests || null,
        ...(pickupAddress ? { pickup: { address: pickupAddress, ...(pickupAreaName ? { areaName: pickupAreaName } : {}) } } : {}),
        // NOT a platform payment. PENDING means "the platform has not been
        // paid", which is exactly true for a walk-in who hands over cash.
        paymentStatus: 'PENDING',
        paymentTiming: 'now',
        status: 'PENDING',
      },
    });

    // 9. Initial collection, if the supplier reports money in hand.
    if (collection && Number(collection.amount) > 0) {
      const row = await tx.bookingCollection.create({
        data: {
          bookingId: created.id,
          supplierId,
          amount: collection.amount,
          currency: created.currency,
          method: collection.method,
          status: 'RECORDED',
          collectedAt: collection.collectedAt ? new Date(collection.collectedAt) : new Date(),
          recordedById: actorId,
          externalRef: collection.externalRef || null,
          note: collection.note || null,
          idempotencyKey: `${String(idempotencyKey)}:collection`,
        },
      });

      // 10. Commission follows the money this row records. Raised through the
      //     shared ledger so this path and `/collections` cannot drift apart.
      await raiseCollectionCommission(tx, {
        booking: { ...created, commissionPolicy: policy },
        collection: row,
        supplierId,
        actorId,
      });
    }

    // 11. Record the idempotency claim with the booking it produced.
    await tx.bookingIdempotencyKey.upsert({
      where: { supplierId_key: { supplierId, key: String(idempotencyKey) } },
      update: { requestHash, bookingId: created.id },
      create: {
        supplierId,
        key: String(idempotencyKey),
        requestHash,
        bookingId: created.id,
      },
    });

    await logActivity({
      userId: actorId,
      action: 'booking.supplier_created',
      resource: 'Booking',
      resourceId: created.id,
      metadata: {
        bookingNumber: created.bookingNumber,
        tourId,
        travelDate: dateKey,
        total: Number(pricing.total),
        currency: created.currency,
        commissionPolicy: policy,
        commissionRate: frozenRate,
        collected: collection ? Number(collection.amount) : 0,
      },
    });

    return created;
  });

  // ── AFTER COMMIT: notifications. Nothing external runs inside the
  //    transaction, so a slow or failing email can never roll back a booking.
  try {
    await enqueueNotification({
      userId: supplierId,
      type: 'BOOKING_CREATED_BY_SUPPLIER',
      title: 'Booking created',
      message: `Booking ${booking.bookingNumber} was created for ${guest?.name || 'a customer'}.`,
      data: { bookingId: booking.id, origin: ORIGIN },
    });
    // A guest with no email simply gets no mail — the relay is never faked.
    if (guest?.email) {
      await enqueueEmail({
        type: 'supplier-created-booking-confirmation',
        bookingId: booking.id,
        data: { bookingId: booking.id, guestName: guest.name, brandKey },
      });
    }
  } catch (err) {
    // The booking is committed and correct; a notification failure is logged
    // for retry/reconciliation, never treated as a failed booking.
    logger.warn(`[SupplierBooking] notification dispatch failed for ${booking.id}: ${err.message}`);
  }

  return booking;
}

/** Collections, outstanding balance and the commission ledger, for one booking. */
async function collectionSummary(bookingId) {
  const rows = await prisma.bookingCollection.findMany({
    where: { bookingId },
    orderBy: { collectedAt: 'asc' },
  });
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { grossAmount: true, currency: true },
  });
  const collected = rows
    .filter((r) => r.status === 'RECORDED')
    .reduce((sum, r) => sum + Number(r.amount), 0);
  const total = booking ? Number(booking.grossAmount) : 0;
  return {
    collections: rows,
    collected,
    outstanding: Math.max(0, Math.round((total - collected) * 100) / 100),
    total,
    currency: booking?.currency || 'USD',
    state: collected <= 0 ? 'NONE' : collected + 0.005 >= total ? 'FULL' : 'PARTIAL',
    // "Recorded as collected" is the ledger; this is what the platform is
    // owed on top of it. Never called "total paid" — the platform was not
    // paid, the supplier collected the money.
    commission: await bookingCommission(bookingId),
  };
}

/**
 * Record money the supplier reports collecting (or returning). Partial
 * collections are separate rows; a correction reverses the original and
 * writes a new one — it never edits history. Every row moves the commission
 * ledger: a collection raises its share, a correction takes back the original
 * and raises the corrected amount, a refund returns the commission on the
 * money given back.
 */
async function recordCollection({
  bookingId,
  supplierId,
  actorId,
  amount,
  method,
  collectedAt,
  externalRef,
  note,
  idempotencyKey,
  reversesId,
}) {
  const key = String(idempotencyKey || '').trim();
  if (key.length < 8) throw new AppError('An idempotency key is required', 400);

  return prisma.$transaction(async (tx) => {
    // The no-credit cover check below reads a balance other collections move.
    // Same lock, and same order (supplier → nothing else here), as create.
    const [lockedSupplier] = await tx.$queryRawUnsafe(
      'SELECT id FROM "User" WHERE id = $1 FOR UPDATE',
      supplierId,
    );
    if (!lockedSupplier) throw new AppError('Supplier not found', 404);

    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      include: { tour: { select: { supplierId: true } } },
    });
    if (!booking || booking.tour?.supplierId !== supplierId) {
      throw new AppError('Booking not found or not yours', 404);
    }
    if (booking.origin !== ORIGIN) {
      throw new AppError('Offline collections apply to supplier-created bookings only', 409);
    }

    const existing = await tx.bookingCollection.findUnique({
      where: { bookingId_idempotencyKey: { bookingId, idempotencyKey: key } },
    });
    if (existing) return existing; // replay: one row, one amount

    const value = Number(amount);
    if (!Number.isFinite(value) || value === 0) {
      throw new AppError('A non-zero amount is required', 400);
    }

    // A CORRECTION replaces a mis-keyed collection with the right amount: it
    // must be positive, must point at a row on this booking, and that row must
    // not already be reversed (reversing twice would take back commission
    // twice). A REFUND is ordinary money going the other way and carries no
    // reversesId — mixing the two would double-count, so the two shapes are
    // kept distinct rather than inferred.
    let reversedRow = null;
    if (reversesId) {
      if (value <= 0) {
        throw new AppError('A correction must have a positive amount — use the refund endpoint to return money', 400);
      }
      reversedRow = await tx.bookingCollection.findFirst({
        where: { id: reversesId, bookingId },
      });
      if (!reversedRow) throw new AppError('The collection being corrected was not found', 404);
      if (reversedRow.status === 'REVERSED') {
        throw new AppError('That collection has already been corrected', 409);
      }
    }

    // A collection may not exceed the outstanding balance; a refund may not
    // exceed what was collected. No silent overpayments. A CORRECTION is
    // measured against the row it replaces: that money was already counted, so
    // replacing 400 with 300 is not a second collection of 300.
    const summary = await collectionSummary(bookingId);
    const ceiling = round2(summary.outstanding + (reversedRow ? Number(reversedRow.amount) : 0));
    if (value > 0 && value > ceiling + 0.005) {
      throw new AppError(
        `That exceeds the outstanding balance of ${ceiling} ${summary.currency}`,
        409,
      );
    }
    if (value < 0 && Math.abs(value) > summary.collected + 0.005) {
      throw new AppError('A refund cannot exceed what was collected', 409);
    }

    // NO CREDIT. The commission this row raises must be covered by money the
    // platform already holds for this supplier. A correction is checked on the
    // NET movement, since it both raises and takes back. Refunds are not
    // gated: returning money cannot create a receivable.
    if (value > 0) {
      const policy = await frozenPolicyFor(booking);
      let required = commissionFor(booking, value, policy);
      if (reversedRow) {
        required = commissionFor(booking, value - Number(reversedRow.amount), policy);
      }
      if (required > 0) {
        await assertCover({
          tx,
          supplierId,
          currency: booking.currency,
          required,
          verb: 'record this collection',
        });
      }
    }

    const row = await tx.bookingCollection.create({
      data: {
        bookingId,
        supplierId,
        amount: value,
        currency: booking.currency,
        method,
        status: 'RECORDED',
        collectedAt: collectedAt ? new Date(collectedAt) : new Date(),
        recordedById: actorId,
        externalRef: externalRef || null,
        note: note || null,
        reversesId: reversesId || null,
        idempotencyKey: key,
      },
    });

    // ── Commission follows this ledger movement ──
    const bookingForLedger = {
      id: booking.id,
      commissionRate: booking.commissionRate,
      commissionPolicy: booking.commissionPolicy,
      currency: booking.currency,
    };

    if (value < 0) {
      // A booking refunded to zero owns no commission. Zeroing every charge
      // rather than crediting each by its own rounded share means rounding
      // cannot leave a cent behind on a booking nobody owes anything on.
      const netAfter = round2(summary.collected + value);
      if (Math.abs(netAfter) < 0.005) {
        await zeroBookingCommission(tx, { booking: bookingForLedger, actorId });
      } else {
        await raiseCollectionCommission(tx, {
          booking: bookingForLedger,
          collection: row,
          supplierId,
          actorId,
        });
      }
    } else {
      if (reversedRow) {
        await reverseCollectionCommission(tx, {
          booking: bookingForLedger,
          originalCollection: reversedRow,
          actorId,
        });
      }
      await raiseCollectionCommission(tx, {
        booking: bookingForLedger,
        collection: row,
        supplierId,
        actorId,
      });
    }

    if (reversedRow) {
      await tx.bookingCollection.update({
        where: { id: reversesId },
        data: { status: 'REVERSED' },
      });
    }

    await logActivity({
      userId: actorId,
      action: value > 0 ? 'booking.collection_recorded' : 'booking.offline_refund_recorded',
      resource: 'Booking',
      resourceId: bookingId,
      metadata: {
        collectionId: row.id,
        amount: value,
        currency: booking.currency,
        method,
        externalRef: externalRef || null,
        reversesId: reversesId || null,
      },
    });

    return row;
  });
}

module.exports = {
  ORIGIN,
  isFeatureEnabled,
  assertFeatureEnabled,
  commissionPolicy,
  quoteBooking,
  createBooking,
  recordCollection,
  collectionSummary,
  coverBalance,
  bookingCommission,
};
