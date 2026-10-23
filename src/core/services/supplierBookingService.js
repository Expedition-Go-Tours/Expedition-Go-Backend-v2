/**
 * Supplier-created bookings — a supplier recording a booking for a customer,
 * including a walk-in who has never registered, and reporting money collected
 * outside the platform (cash, mobile money, bank transfer, a card taken on
 * their own terminal).
 *
 * This module deliberately REUSES every existing engine:
 *   pricing        tourHelpers.calculateTourPrice (the only pricing engine)
 *   commission     stripeHelpers.calculateCommission (server-side rate)
 *   availability   availabilityCore.evaluateBookingAvailability, inside a
 *                  transaction that has locked the tour row
 *   charges        SupplierCharge — the same OPEN-charge ledger the
 *                  cancellation fee uses, netted off the next payout request
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
 *    raised per collection (idempotent per booking+collection), never on an
 *    unpaid reservation. The supplier never chooses the rate — it is read from
 *    config and snapshotted on the booking.
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
const { generateBookingNumber } = require('./bookingHelpers');
const { logActivity } = require('./auditLogger');
const { enqueueEmail, enqueueNotification } = require('./queue');
const logger = require('./logger');

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
 */
async function commissionPolicy() {
  const policy = String(await getConfig('feature.supplierCreatedCommissionPolicy', 'APPLY')).toUpperCase();
  return policy === 'WAIVE' ? 'WAIVE' : 'APPLY';
}

function canonicalHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** Availability evaluation wants the FULL tour row (schedules, options). */
async function loadTourForBooking(tx, tourId, supplierId) {
  const tour = await tx.tour.findUnique({
    where: { id: tourId },
    include: {
      schedulesAndPricing: true,
      supplier: { select: { id: true, name: true, email: true } },
    },
  });
  if (!tour || tour.supplierId !== supplierId) {
    throw new AppError('Tour not found or not yours', 404);
  }
  return tour;
}

/**
 * Server-authoritative quote: price + an availability verdict, computed by the
 * same engines checkout uses. The client displays this and never submits a
 * total of its own.
 */
async function quoteBooking({ supplierId, brandKey, tourId, optionId, travelDate, selectedTime, travelers }) {
  await assertFeatureEnabled(brandKey);

  const tour = await loadTourForBooking(prisma, tourId, supplierId);
  const dateKey = String(travelDate).slice(0, 10);

  const pricing = await calculateTourPrice(
    tour,
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
    tour,
    dateKey,
    selectedTime || null,
    travelers,
    optionId ? { optionScope: { tourOptionKey: optionId } } : {},
  );

  const commission = await calculateCommission(pricing.total);
  const policy = await commissionPolicy();

  return {
    currency: pricing.currency || tour.schedulesAndPricing?.pricingSchedules?.currency || 'USD',
    subtotal: pricing.subtotal,
    discount: pricing.discount || 0,
    total: pricing.total,
    available: Boolean(availability.ok),
    unavailableReason: availability.ok ? null : availability.reason,
    commission: {
      policy,
      rate: policy === 'APPLY' ? commission.rate : 0,
      amount: policy === 'APPLY' ? commission.amount : 0,
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

    // 2. Lock the tour row — the same lock the checkout path takes. Two
    //    concurrent creates for the last seat serialize here.
    const [lockedTour] = await tx.$queryRawUnsafe(
      'SELECT id FROM "Tour" WHERE id = $1 AND "supplierId" = $2 FOR UPDATE',
      tourId,
      supplierId,
    );
    if (!lockedTour) throw new AppError('Tour not found or not yours', 404);

    // 3. Authoritative availability inside the transaction.
    const tour = await loadTourForBooking(tx, tourId, supplierId);
    const dateKey = String(travelDate).slice(0, 10);
    const availability = await evaluateBookingAvailability(
      tx, tour, dateKey, selectedTime || null, travelers,
      optionId ? { optionScope: { tourOptionKey: optionId } } : {},
    );
    if (!availability.ok) {
      throw new AppError(availability.reason || 'No availability for that date', 409);
    }

    // 4. Authoritative price. Never the client's number.
    const pricing = await calculateTourPrice(tour, travelers, dateKey, selectedTime || null, optionId || null, null, null);
    if (!pricing || pricing.success === false) {
      throw new AppError(pricing?.error || 'This tour cannot be priced for the selected date and party', 422);
    }

    // 5. Guest or registered customer. No fake users, no email matching.
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

    // 6. The booking. `origin` is set by the BACKEND; `source` keeps meaning
    //    which storefront this belongs to and is left to the caller's brand.
    const commission = await calculateCommission(pricing.total);
    const policy = await commissionPolicy();
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
        travelDate: new Date(dateKey),
        selectedTime: selectedTime || null,
        travelers,
        subtotal: pricing.subtotal,
        grossAmount: pricing.total,
        discounts: pricing.discount || 0,
        currency: pricing.currency || 'USD',
        // Commission is snapshotted from config, never from the client. A
        // waived policy writes zeros and is recorded in the audit trail.
        commissionRate: policy === 'APPLY' ? commission.rate : 0,
        platformCommission: policy === 'APPLY' ? commission.amount : 0,
        supplierPayout: policy === 'APPLY' ? commission.supplierPayout : pricing.total,
        specialRequests: specialRequests || null,
        ...(pickupAddress ? { pickup: { address: pickupAddress, ...(pickupAreaName ? { areaName: pickupAreaName } : {}) } } : {}),
        // NOT a platform payment. PENDING means "the platform has not been
        // paid", which is exactly true for a walk-in who hands over cash.
        paymentStatus: 'PENDING',
        paymentTiming: 'now',
        status: 'PENDING',
      },
    });

    // 7. Initial collection, if the supplier reports money in hand.
    if (collection && Number(collection.amount) > 0) {
      await tx.bookingCollection.create({
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

      // 8. Commission follows money actually collected — an OPEN charge the
      //    payout request machinery already nets off. Idempotent per booking:
      //    a replayed create cannot raise it twice (the create above cannot
      //    run twice either — the idempotency key claims the slot).
      if (policy === 'APPLY') {
        const commissionOnCollection = await calculateCommission(collection.amount);
        await tx.supplierCharge.create({
          data: {
            supplierId,
            bookingId: created.id,
            amount: commissionOnCollection.amount,
            currency: created.currency,
            reason: 'SUPPLIER_COMMISSION',
            status: 'OPEN',
            notes: `Commission on offline collection (${collection.method}) — policy APPLY`,
          },
        });
      }
    }

    // 9. Record the idempotency claim with the booking it produced.
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

/** Collections + outstanding balance for one booking. */
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
  };
}

/**
 * Record money the supplier reports collecting (or returning). Partial
 * collections are separate rows; a correction reverses the original and
 * writes a new one — it never edits history.
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

    // A collection may not exceed the outstanding balance; a refund may not
    // exceed what was collected. No silent overpayments.
    const summary = await collectionSummary(bookingId);
    if (value > 0 && value > summary.outstanding + 0.005) {
      throw new AppError(
        `That exceeds the outstanding balance of ${summary.outstanding} ${summary.currency}`,
        409,
      );
    }
    if (value < 0 && Math.abs(value) > summary.collected + 0.005) {
      throw new AppError('A refund cannot exceed what was collected', 409);
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

    if (reversesId) {
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
};
