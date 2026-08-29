const prisma = require('./prismaClient');
const { evaluateBookingAvailability, travelerCount } = require('./availabilityCore');
const { generateBookingNumber } = require('./bookingHelpers');

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
}) {
  const seats = travelerCount(travelers);

  const draft = await prisma.$transaction(async (tx) => {
    // ── Serialize on the tour row (same lock used by confirmBooking,
    //    override writes, and delete checks). ──────────────────────
    const [locked] = await tx.$queryRawUnsafe(
      `SELECT id FROM "Tour" WHERE id = $1 FOR UPDATE`,
      tourId
    );
    if (!locked) throw new Error('Tour not found');

    // ── Capacity check: bookings + other active holds ────────────
    const evalResult = await evaluateBookingAvailability(
      tx, tour, travelDate, selectedTime, travelers
    );
    if (!evalResult.ok) throw new Error(evalResult.reason);

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
        payload: { ...(payload ?? {}), _source: source || 'EXPEDITION', _bookingPrefix: bookingPrefix || 'EXP' },
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

    // Read source/prefix from draft payload (set by acquireHold)
    const source = draftRecord.payload?._source || 'EXPEDITION';
    const bookingPrefix = draftRecord.payload?._bookingPrefix || 'EXP';

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
    const evalResult = await evaluateBookingAvailability(
      tx, tourRecord, draftRecord.travelDate, draftRecord.selectedTime,
      draftRecord.payload.travelers,
      { excludeDraftId: draftId }
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
    const booking = await tx.booking.create({
      data: {
        bookingNumber,
        customerId: draftRecord.customerId,
        tourId: draftRecord.tourId,
        source,
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
        pickup: draftRecord.payload.pickup || null,
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
        travelDate: draftRecord.travelDate,
      },
    }).catch(() => {});

    createdBooking = booking;
    return draftRecord;
  });

  if (!draft) {
    return { ok: false, reason: oversold ? 'sold_out' : 'already_settled', oversold };
  }

  // ── Supplier notification (after commit, fire-and-forget) ─────────────
  // Pay-now bookings never notified the supplier before; the draft carries the
  // platform so the message and data.source are correct for either storefront.
  try {
    const { enqueueNotification } = require('./queue');
    const source = draft.payload?._source || 'EXPEDITION';
    const isGhana = source === 'GHANA';
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
