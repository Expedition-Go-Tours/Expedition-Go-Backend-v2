const prisma = require('./prismaClient');

/**
 * Booking statuses that are owed a supplier payout. Shared by every money
 * predicate — the v3 invoice selection, the eligibility sweep, and the v2
 * "eligible now" clause — so they cannot drift apart.
 *
 * NO_SHOW is payable: the supplier ran the tour, the booking is
 * non-refundable, and GetYourGuide's Supplier T&C §3.9(ii) treats a no-show
 * "as a Completed Booking for purposes of payment". Refunded money never
 * reaches these predicates anyway — they all require paymentStatus SUCCEEDED.
 */
const PAYABLE_BOOKING_STATUSES = Object.freeze(['CONFIRMED', 'COMPLETED', 'NO_SHOW']);

// ── Finance v2 shared helpers ──
// Used by booking/expedition cancellation flows and the dispute service to
// keep PayoutRequests consistent when a booking's funds change state.

/**
 * Detach a booking from any active (PROCESSING/APPROVED) payout request.
 * Adjusts the request's amount and bookingCount; cancels the request when
 * its last item is removed. Completed requests are left untouched — their
 * ledger rows are immutable and corrections happen via disputes/refunds.
 *
 * @param {object} tx Prisma transaction client (or prisma)
 * @param {string} bookingId
 * @returns {Promise<number>} number of requests adjusted
 */
async function detachBookingFromActiveRequests(tx, bookingId) {
  const client = tx || prisma;

  const items = await client.payoutRequestItem.findMany({
    where: {
      bookingId,
      payoutRequest: { status: { in: ['PROCESSING', 'APPROVED'] } },
    },
    include: { payoutRequest: { include: { _count: { select: { items: true } } } } },
  });

  let adjusted = 0;
  for (const item of items) {
    const request = item.payoutRequest;
    const remaining = request.bookingCount - 1;

    if (remaining <= 0) {
      await client.payoutRequest.update({
        where: { id: request.id },
        data: { status: 'CANCELLED', notes: 'Cancelled automatically — all bookings were removed' },
      });
      await client.payoutRequestItem.deleteMany({ where: { payoutRequestId: request.id } });
    } else {
      await client.payoutRequestItem.delete({ where: { id: item.id } });
      await client.payoutRequest.update({
        where: { id: request.id },
        data: {
          amount: { decrement: item.supplierPayout },
          bookingCount: { decrement: 1 },
        },
      });
    }
    adjusted += 1;
  }
  return adjusted;
}

/**
 * Mark a booking's funds as CANCELLED (customer cancelled / refunded).
 * Detaches it from any active payout request so suppliers are never paid
 * for cancelled experiences.
 */
async function cancelBookingFunds(tx, bookingId) {
  const client = tx || prisma;
  await client.booking.update({
    where: { id: bookingId },
    data: { payoutStatus: 'CANCELLED' },
  });
  await detachBookingFromActiveRequests(client, bookingId);
}

/**
 * Freeze a booking's funds because of an open dispute. Only flips
 * ELIGIBLE/PENDING bookings — REQUESTED ones stay in their request but the
 * dispute blocks completion until resolved (enforced by admin complete flow).
 */
async function freezeBookingForDispute(tx, bookingId) {
  const client = tx || prisma;
  await client.booking.updateMany({
    where: { id: bookingId, payoutStatus: { in: ['PENDING', 'ELIGIBLE'] } },
    data: { payoutStatus: 'DISPUTED' },
  });
}

/**
 * Unfreeze after a dispute resolves in the supplier's favor — funds return
 * to ELIGIBLE (the sweep will re-eligibilize PENDING ones later).
 */
async function unfreezeBookingAfterDispute(tx, bookingId) {
  const client = tx || prisma;
  await client.booking.updateMany({
    where: { id: bookingId, payoutStatus: 'DISPUTED' },
    data: { payoutStatus: 'ELIGIBLE' },
  });
}

/**
 * The booking filter every payout figure on the platform is derived from.
 *
 * This exists because the clause used to be restated at four separate call
 * sites — two aggregates in the admin schedules list, the supplier's own
 * finance summary, and `selectEligibleBookings`, which is the one that
 * actually decides what gets paid. They agree today, but nothing kept them
 * agreeing: edit one and the "Eligible now" a finance officer reads quietly
 * stops meaning "the amount that run will pay". Now they all call this.
 *
 * The four conditions:
 *   isSimulated      — demo/seed bookings are not real money, and every other
 *                      money view on the platform already excludes them;
 *   payoutStatus     — ELIGIBLE is claimable; PENDING is still inside the
 *                      clearance buffer; DISPUTED/CANCELLED are frozen;
 *   paymentStatus    — we do not advance money the customer has not paid;
 *   status           — a cancelled or refunded experience is not owed payout,
 *                      but a NO_SHOW is: it is non-refundable and counts as
 *                      completed for payment (GetYourGuide parity, see
 *                      PAYABLE_BOOKING_STATUSES).
 *
 * Open disputes are handled earlier, in `sweepEarningsEligibility`, which
 * refuses to flip a booking into ELIGIBLE while a dispute is live — so they
 * never reach this clause at all.
 *
 * @param {object} [opts]
 * @param {string} [opts.supplierId]     a single supplier
 * @param {string[]} [opts.supplierIds]  several, for a batch aggregate
 * @param {string} [opts.payoutStatus='ELIGIBLE']
 * @returns {object} a Prisma `where` fragment
 */
function payoutBookingsWhere({ supplierId, supplierIds, payoutStatus = 'ELIGIBLE' } = {}) {
  const where = {
    isSimulated: false,
    payoutStatus,
    paymentStatus: 'SUCCEEDED',
    status: { in: [...PAYABLE_BOOKING_STATUSES] },
  };
  if (supplierId) where.tour = { supplierId };
  else if (supplierIds && supplierIds.length > 0) where.tour = { supplierId: { in: supplierIds } };
  return where;
}

/** The subset of a supplier's bookings that is claimable for payout right now. */
function eligibleBookingsWhere(supplierId) {
  return payoutBookingsWhere({ supplierId });
}

module.exports = {
  PAYABLE_BOOKING_STATUSES,
  detachBookingFromActiveRequests,
  cancelBookingFunds,
  freezeBookingForDispute,
  unfreezeBookingAfterDispute,
  payoutBookingsWhere,
  eligibleBookingsWhere,
};
