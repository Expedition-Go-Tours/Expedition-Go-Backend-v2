/**
 * Same-day customer cancellation requests.
 *
 * The free-cancellation window ends 24 hours before the activity, so on the
 * activity date a customer cannot self-cancel for a refund. The policy we
 * expose instead is:
 *
 *   customer asks to cancel  ->  supplier approves or declines
 *   approve                  ->  booking cancelled, NO refund, no supplier fee
 *   decline                  ->  booking stays active
 *
 * The request is stored on the booking (one per booking) so both the customer
 * and supplier payloads carry its state without a join. Approval writes the
 * customer-origin cancellation fields, so the supplier's cancellation rate is
 * untouched and the existing reporting/email outcome logic sees a normal
 * customer cancellation with a zero refund.
 */

const prisma = require('./prismaClient');
const AppError = require('./appError');
const { activityStart, evaluateCancellationPolicy } = require('./bookingHelpers');
const { detachBookingFromActiveRequests } = require('./financeHelpers');
const { detachBookingFromInvoices } = require('./invoiceService');
const { enqueueEmail, enqueueNotification } = require('./queue');
const { logActivity } = require('./auditLogger');
const emailUrls = require('../../../config/emailUrls');
const { resolveEmailBrand, sendEmail } = require('./emailService');
const { CUSTOMER_REASON_BY_CODE, humanizeReasonCode } = require('./cancellationReasons');

const STATUS = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  DECLINED: 'DECLINED',
  WITHDRAWN: 'WITHDRAWN',
});

const ACTIVE_STATUSES = ['PENDING', 'CONFIRMED'];
const HAS_TIME = /^\d{1,2}:\d{2}/;

function utcDay(value) {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Is the booking's activity today (UTC calendar day)? */
function isActivityDate(booking, now = new Date()) {
  const travel = utcDay(booking?.travelDate);
  const today = utcDay(now);
  return travel !== null && travel === today;
}

/**
 * When does the activity actually start? With a time slot we use it; without
 * one we fall back to the end of the travel day, because there is no clock to
 * point at and closing at midnight would make the whole day uncancellable.
 */
function activityCutoff(booking) {
  const start = activityStart(booking);
  if (!start) return null;
  if (HAS_TIME.test(String(booking?.selectedTime || ''))) return start;
  return new Date(start.getTime() + (24 * 60 * 60 * 1000) - 1);
}

function activityHasStarted(booking, now = new Date()) {
  const cutoff = activityCutoff(booking);
  return cutoff ? now >= cutoff : false;
}

function travelerTotal(travelers) {
  const t = travelers && typeof travelers === 'object' ? travelers : {};
  return (t.adults || 0) + (t.children || 0) + (t.infants || 0) || 1;
}

function moneyLabel(booking) {
  return `${booking.currency || 'USD'} ${Number(booking.grossAmount || 0).toFixed(2)}`;
}

async function loadBooking(id) {
  return prisma.booking.findUnique({
    where: { id },
    include: {
      tour: { select: { id: true, title: true, supplierId: true, supplier: { select: { id: true, name: true, email: true, roles: true } } } },
      customer: { select: { id: true, name: true, email: true } },
    },
  });
}

/**
 * The customer asks the supplier to cancel. Only valid on the activity date,
 * before the activity starts, and only when the normal cancellation policy
 * would refuse (otherwise the normal self-service cancel is the right path).
 */
async function requestCustomerCancellation({ booking, customerId, reason, note }) {
  if (!ACTIVE_STATUSES.includes(booking.status)) {
    throw new AppError(`Booking is ${booking.status} and can no longer be cancelled`, 409);
  }
  if (booking.customerId !== customerId) {
    throw new AppError('Booking not found', 404);
  }
  if (!isActivityDate(booking)) {
    throw new AppError('Same-day cancellation requests are only available on the activity date', 400);
  }
  if (activityHasStarted(booking)) {
    throw new AppError('The activity has already started — contact support if you need help', 400);
  }
  const check = evaluateCancellationPolicy(booking, booking.tour);
  if (check.allowed) {
    throw new AppError('This booking can still be cancelled normally', 400);
  }
  if (booking.customerCancellationStatus === STATUS.PENDING) {
    throw new AppError('A cancellation request for this booking is already awaiting the supplier', 409);
  }
  if (booking.customerCancellationStatus === STATUS.DECLINED) {
    throw new AppError('The supplier has already declined a cancellation request for this booking', 409);
  }

  const now = new Date();
  const reasonLabel = CUSTOMER_REASON_BY_CODE[String(reason || '').toUpperCase()]?.label
    || humanizeReasonCode(reason)
    || null;
  const updated = await prisma.booking.update({
    where: { id: booking.id },
    data: {
      customerCancellationStatus: STATUS.PENDING,
      customerCancellationReason: reasonLabel,
      customerCancellationNote: note || null,
      customerCancellationRequestedAt: now,
      customerCancellationDecidedAt: null,
      customerCancellationDecidedBy: null,
      customerCancellationDecisionNote: null,
    },
  });

  const supplier = booking.tour?.supplier;
  if (supplier?.id) {
    enqueueNotification({
      userId: supplier.id,
      type: 'CUSTOMER_CANCELLATION_REQUESTED',
      title: 'Same-day cancellation needs your decision',
      message: `${booking.leadTravelerName || booking.customer?.name || 'A traveller'} asked to cancel booking ${booking.bookingNumber} on the activity date. Approval is non-refundable.`,
      data: {
        bookingId: booking.id,
        bookingNumber: booking.bookingNumber,
        travelDate: booking.travelDate,
        reason: reason || null,
        note: note || null,
        buttonUrl: `${emailUrls.supplierBookingsForUser(supplier)}?bookingId=${encodeURIComponent(booking.id)}`,
        buttonText: 'Review booking',
      },
      sendEmail: true,
      emailTemplate: 'generic-notification',
    }).catch((err) => console.error('[CustomerCancellation] supplier notification failed:', err.message));
  }

  logActivity({
    userId: customerId,
    action: 'booking.customer_cancellation_requested',
    resource: 'Booking',
    resourceId: booking.id,
    metadata: { reason: reason || null, note: note || null },
  }).catch(() => {});

  return updated;
}

/** The customer can withdraw before the supplier decides. */
async function withdrawCustomerCancellation({ booking, customerId }) {
  if (booking.customerId !== customerId) throw new AppError('Booking not found', 404);
  if (booking.customerCancellationStatus !== STATUS.PENDING) {
    throw new AppError('There is no pending cancellation request to withdraw', 409);
  }
  return prisma.booking.update({
    where: { id: booking.id },
    data: { customerCancellationStatus: STATUS.WITHDRAWN, updatedAt: new Date() },
  });
}

/**
 * Supplier decision. Approval cancels with no refund and no fee; the supplier
 * must still have the booking-management permission at the route boundary.
 */
async function decideCustomerCancellation({ booking, supplierId, approve, note = null }) {
  if (booking.customerCancellationStatus !== STATUS.PENDING) {
    throw new AppError('There is no pending cancellation request for this booking', 409);
  }
  if (!ACTIVE_STATUSES.includes(booking.status)) {
    throw new AppError(`Booking is already ${booking.status}`, 409);
  }

  const now = new Date();

  if (!approve) {
    const declined = await prisma.booking.updateMany({
      where: { id: booking.id, customerCancellationStatus: STATUS.PENDING },
      data: {
        customerCancellationStatus: STATUS.DECLINED,
        customerCancellationDecidedAt: now,
        customerCancellationDecidedBy: supplierId,
        customerCancellationDecisionNote: note || null,
        updatedAt: now,
      },
    });
    if (declined.count === 0) throw new AppError('The request has already been decided', 409);

    notifyCustomerDeclined(booking, note);
    logActivity({
      userId: supplierId,
      action: 'booking.customer_cancellation_declined',
      resource: 'Booking',
      resourceId: booking.id,
      metadata: { note: note || null },
    }).catch(() => {});
    return loadBooking(booking.id);
  }

  // Approval: cancel as a customer-origin, non-refundable cancellation.
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.booking.updateMany({
      where: {
        id: booking.id,
        status: { in: ACTIVE_STATUSES },
        customerCancellationStatus: STATUS.PENDING,
      },
      data: {
        status: 'CANCELLED',
        cancellationReason: booking.customerCancellationReason || 'CUSTOMER_REQUESTED_CANCEL',
        cancellationNote: booking.customerCancellationNote || null,
        cancellationCode: 'CUSTOMER_REQUESTED_CANCEL',
        cancellationCategory: 'CUSTOMER_REQUESTED',
        cancellationOrigin: 'CUSTOMER',
        countsTowardRate: false,
        cancellationFee: null,
        refundStatus: 'NOT_APPLICABLE',
        refundAmount: null,
        cancelledAt: now,
        payoutStatus: 'CANCELLED',
        customerCancellationStatus: STATUS.APPROVED,
        customerCancellationDecidedAt: now,
        customerCancellationDecidedBy: supplierId,
        customerCancellationDecisionNote: note || null,
        updatedAt: now,
      },
    });
    if (claimed.count === 0) throw new AppError('The request has already been decided', 409);

    // A cancelled booking must never pay the supplier.
    await tx.payout.updateMany({
      where: { bookingId: booking.id, status: 'PENDING' },
      data: { status: 'CANCELLED', processedAt: now },
    });
    await detachBookingFromActiveRequests(tx, booking.id);
    await detachBookingFromInvoices(tx, booking.id);

    if (booking.appliedOfferId) {
      await tx.specialOffer.update({
        where: { id: booking.appliedOfferId },
        data: { spotsSold: { decrement: travelerTotal(booking.travelers) } },
      }).catch(() => {});
    }
  });

  notifyCustomerApproved(booking);
  notifySupplierCancellationRecord(booking, supplierId);
  logActivity({
    userId: supplierId,
    action: 'booking.customer_cancellation_approved',
    resource: 'Booking',
    resourceId: booking.id,
    metadata: { note: note || null, refundAmount: 0 },
  }).catch(() => {});

  return loadBooking(booking.id);
}

function customerEmailFor(booking) {
  return booking.customer?.email || booking.leadTravelerEmail || null;
}

function notifyCustomerApproved(booking) {
  const paid = booking.paymentStatus === 'SUCCEEDED';
  enqueueEmail({
    type: paid ? 'customer-cancelled-no-refund' : 'customer-cancelled-unpaid',
    bookingId: booking.id,
    data: { cancellationOrigin: 'CUSTOMER', refundAmount: 0 },
  }).catch((err) => console.error('[CustomerCancellation] customer email failed:', err.message));

  enqueueEmail({
    type: paid ? 'supplier-customer-cancelled-late' : 'supplier-customer-cancelled-unpaid',
    bookingId: booking.id,
    data: { cancellationOrigin: 'CUSTOMER', refundAmount: 0 },
  }).catch((err) => console.error('[CustomerCancellation] supplier email failed:', err.message));

  if (booking.customerId) {
    enqueueNotification({
      userId: booking.customerId,
      type: 'CUSTOMER_CANCELLATION_APPROVED',
      title: 'Cancellation approved',
      message: `The supplier approved your cancellation for booking ${booking.bookingNumber}. The activity was on the same day, so no refund applies.`,
      data: { bookingId: booking.id, refundAmount: 0 },
    }).catch((err) => console.error('[CustomerCancellation] customer notification failed:', err.message));
  }
}

function notifyCustomerDeclined(booking, note) {
  const email = customerEmailFor(booking);
  const message = `The supplier could not approve the cancellation for booking ${booking.bookingNumber}. The booking remains active.${note ? ` Note from the supplier: ${note}` : ''}`;

  if (booking.customerId) {
    enqueueNotification({
      userId: booking.customerId,
      type: 'CUSTOMER_CANCELLATION_DECLINED',
      title: 'Cancellation request declined',
      message,
      data: { bookingId: booking.id, note: note || null },
    }).catch((err) => console.error('[CustomerCancellation] customer notification failed:', err.message));
  }

  if (email) {
    const brandKey = resolveEmailBrand({ booking });
    sendEmail({
      to: email,
      subject: `Cancellation request declined — ${booking.bookingNumber}`,
      template: 'generic-notification',
      opts: { brandKey },
      data: {
        title: 'Cancellation request declined',
        message,
        buttonUrl: emailUrls.bookingClientOrigin(booking)
          ? `${emailUrls.bookingClientOrigin(booking)}/dashboard/bookings?booking=${encodeURIComponent(booking.id)}`
          : undefined,
        buttonText: 'View booking',
      },
    }).catch((err) => console.error('[CustomerCancellation] decline email failed:', err.message));
  }
}

/** A quiet record for the supplier's own booking timeline. */
function notifySupplierCancellationRecord(booking, supplierId) {
  enqueueNotification({
    userId: supplierId,
    type: 'BOOKING_STATUS_UPDATED',
    title: 'Same-day cancellation approved',
    message: `You approved the customer's cancellation for booking ${booking.bookingNumber}. No refund applies and no cancellation fee was raised.`,
    data: { bookingId: booking.id, refundAmount: 0 },
  }).catch((err) => console.error('[CustomerCancellation] supplier confirmation failed:', err.message));
}

module.exports = {
  STATUS,
  isActivityDate,
  activityCutoff,
  activityHasStarted,
  requestCustomerCancellation,
  withdrawCustomerCancellation,
  decideCustomerCancellation,
  // exported for the shared supplier gate
  moneyLabel,
};
