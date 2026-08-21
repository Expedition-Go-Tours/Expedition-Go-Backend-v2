const prisma = require('./prismaClient');

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

module.exports = {
  detachBookingFromActiveRequests,
  cancelBookingFunds,
  freezeBookingForDispute,
  unfreezeBookingAfterDispute,
};
