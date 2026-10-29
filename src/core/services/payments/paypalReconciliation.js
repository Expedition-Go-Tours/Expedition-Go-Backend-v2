/**
 * PayPal refund reconciliation.
 *
 * PayPal can accept a refund instruction and settle it asynchronously (e.g. a
 * card refund that returns PENDING). The refund id is stored on the booking and
 * on any reconciliation row, and this sweep is the only place that turns those
 * pending instructions into a terminal state.
 *
 * There is deliberately no daily "scan every PayPal transaction" job here: the
 * PAYMENT.CAPTURE.COMPLETED webhook fires for every capture on the account,
 * including payments created outside our checkout, and that path already
 * records an unmapped capture and alerts #sales.
 */

const prisma = require('../prismaClient');
const { getRefund } = require('./paypalPayments');
const { isPaypalConfigured } = require('./config');

function mapStatus(status) {
  if (status === 'SUCCEEDED') return { row: 'REFUNDED', booking: 'COMPLETED', done: true };
  if (status === 'PENDING') return { row: 'REFUND_PENDING', booking: 'PENDING', done: false };
  return { row: 'REFUND_FAILED', booking: 'FAILED', done: false };
}

/**
 * Poll refunds recorded directly on a booking (normal cancellation/claim
 * refunds, which do not create a reconciliation row).
 */
async function reconcileBookingRefunds({ limit = 25 } = {}) {
  const bookings = await prisma.booking.findMany({
    where: {
      paymentProvider: 'PAYPAL',
      paypalRefundId: { not: null },
      paypalRefundStatus: { in: ['PENDING', 'PROCESSING'] },
    },
    select: { id: true, bookingNumber: true, paypalRefundId: true, paypalRefundStatus: true },
    orderBy: { updatedAt: 'asc' },
    take: limit,
  });

  let updated = 0;

  for (const booking of bookings) {
    try {
      const { normalized } = await getRefund(booking.paypalRefundId);
      const next = mapStatus(normalized.status);
      if (next.booking === booking.paypalRefundStatus) continue;

      await prisma.booking.update({
        where: { id: booking.id },
        data: {
          paypalRefundStatus: next.booking,
          ...(next.done ? { paymentStatus: 'REFUNDED', refundedAt: new Date() } : {}),
        },
      });

      await prisma.bookingPaymentReconciliation.updateMany({
        where: { paypalCaptureId: { not: null }, bookingId: booking.id },
        data: {
          status: next.row,
          paypalRefundId: booking.paypalRefundId,
          refundedAt: next.done ? new Date() : null,
        },
      }).catch(() => {});

      updated += 1;

      if (next.row === 'REFUND_FAILED') {
        console.warn(`[PayPal] Refund ${booking.paypalRefundId} failed for booking ${booking.bookingNumber || booking.id}`);
      }
    } catch (err) {
      console.warn(`[PayPal] Could not refresh refund ${booking.paypalRefundId}: ${err.message}`);
    }
  }

  return { checked: bookings.length, updated };
}

/**
 * Poll reconciliation rows (late/duplicate/oversold captures that were
 * refunded automatically). These are keyed by capture, not booking.
 */
async function reconcileUnclaimedRefunds({ limit = 25 } = {}) {
  const rows = await prisma.bookingPaymentReconciliation.findMany({
    where: {
      paymentProvider: 'PAYPAL',
      status: 'REFUND_PENDING',
      paypalRefundId: { not: null },
    },
    orderBy: { updatedAt: 'asc' },
    take: limit,
  });

  let updated = 0;

  for (const row of rows) {
    try {
      const { normalized } = await getRefund(row.paypalRefundId);
      const next = mapStatus(normalized.status);
      if (next.row === row.status) continue;

      await prisma.bookingPaymentReconciliation.update({
        where: { id: row.id },
        data: {
          status: next.row,
          refundedAt: next.done ? new Date() : null,
          failureCode: next.row === 'REFUND_FAILED' ? 'REFUND_PROVIDER_FAILED' : null,
        },
      });
      updated += 1;
    } catch (err) {
      console.warn(`[PayPal] Could not refresh unclaimed refund ${row.paypalRefundId}: ${err.message}`);
    }
  }

  return { checked: rows.length, updated };
}

async function reconcilePendingPaypalRefunds() {
  // Nothing to poll when the provider has never been enabled in this
  // environment: skip the queries entirely rather than scan empty tables on
  // every pay-later sweep.
  if (!isPaypalConfigured()) {
    return { bookings: 0, unclaimed: 0, checked: 0, skipped: true };
  }

  const [bookings, unclaimed] = await Promise.all([
    reconcileBookingRefunds().catch((err) => {
      console.warn('[PayPal] Booking refund reconciliation failed:', err.message);
      return { checked: 0, updated: 0 };
    }),
    reconcileUnclaimedRefunds().catch((err) => {
      console.warn('[PayPal] Unclaimed refund reconciliation failed:', err.message);
      return { checked: 0, updated: 0 };
    }),
  ]);

  return {
    bookings: bookings.updated,
    unclaimed: unclaimed.updated,
    checked: bookings.checked + unclaimed.checked,
  };
}

module.exports = {
  reconcilePendingPaypalRefunds,
  reconcileBookingRefunds,
  reconcileUnclaimedRefunds,
};
