/**
 * Post-commit notifications for a supplier-created booking.
 *
 * A supplier recording a booking by hand is still a real booking: the guest
 * must get a confirmation, the supplier must keep a record, the customer's
 * account (when there is one) must light up, and ops must see it in sales.
 * The marketplace path grew those notifications around payment settlement;
 * an offline booking never settles through that pipeline, so it dispatches
 * them here instead of inheriting them by accident.
 *
 * Two rules shape every message:
 *
 *  1. THE GUEST PAID THE SUPPLIER, NOT THE PLATFORM. No email, notification or
 *     Discord embed may say "amount paid" or imply TravioGhana took the money.
 *     Money is "recorded as collected" by the supplier; the rest is still due
 *     to the supplier.
 *  2. NOTHING HERE MAY FAIL THE BOOKING. The booking is already committed and
 *     correct; every channel is independent, so one bad template or a Redis
 *     blip never suppresses the other channels or surfaces to the caller.
 *
 * The booking, its collections and its frozen commission rate are read fresh
 * AFTER commit. That read is the single source for the money labels, so this
 * module and the booking service cannot disagree about what was collected.
 */

const prisma = require('./prismaClient');
const { enqueueEmail, enqueueNotification } = require('./queue');
const { notifyAdmin } = require('./adminNotificationService');
const { notifyDiscord } = require('./discordNotifier');
const { salesBookingRecorded } = require('./channelEmbeds');
const { formatCurrency } = require('./emailFormatting');
const logger = require('./logger');

const ORIGIN = 'SUPPLIER_CREATED';

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

/** Percentage label from the booking's frozen rate (0.15 → "15%"). */
function percentLabel(rate) {
  return `${round2(Number(rate || 0) * 100)}%`;
}

/** Everything the messages need, resolved once from the committed row. */
function contextOf(booking) {
  const supplier = booking.tour?.supplier || {};
  const guest = booking.guest || null;
  const customer = booking.customer || null;
  const person = guest || customer || {};
  const currency = booking.currency || 'USD';

  const total = round2(booking.grossAmount);
  const collected = round2(
    (booking.collections || [])
      // A reversed correction row and its replacement both exist; counting
      // both would double the money. Refund rows are negative and remain
      // RECORDED, so they net out as they should.
      .filter((row) => (row.status || 'RECORDED') === 'RECORDED')
      .reduce((sum, row) => sum + Number(row.amount || 0), 0),
  );
  const balance = round2(Math.max(0, total - collected));

  return {
    supplier,
    currency,
    guestName: person.name || booking.leadTravelerName || 'the guest',
    guestEmail: String((guest?.email || customer?.email) || '').trim(),
    guestPhone: person.phone || booking.leadTravelerPhone || '',
    total,
    collected,
    balance,
    totalLabel: formatCurrency(total, currency),
    collectedLabel: formatCurrency(collected, currency),
    balanceLabel: formatCurrency(balance, currency),
    commissionRate: Number(booking.commissionRate || 0),
    commissionRateLabel: percentLabel(booking.commissionRate),
    commissionPolicy: booking.commissionPolicy || 'APPLY',
  };
}

async function loadBooking(bookingId) {
  return prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      customer: { select: { id: true, name: true, email: true, phone: true } },
      guest: { select: { id: true, name: true, email: true, phone: true } },
      collections: { select: { amount: true, status: true } },
      tour: {
        select: {
          id: true,
          title: true,
          slug: true,
          supplier: { select: { id: true, name: true, email: true, phone: true } },
        },
      },
    },
  });
}

function warn(channel, bookingId, err) {
  logger.warn(`[SupplierBookingNotify] ${channel} failed for ${bookingId}: ${err.message}`);
}

/**
 * Dispatch every notification for a freshly created supplier booking.
 * Resolves with a per-channel result map; never throws.
 */
async function notifySupplierBookingCreated(bookingId) {
  let booking;
  try {
    booking = await loadBooking(bookingId);
  } catch (err) {
    warn('load', bookingId, err);
    return { loaded: false };
  }
  if (!booking) return { loaded: false };

  const ctx = contextOf(booking);
  const result = { loaded: true };

  // 1. The supplier's own bell. This is the one that used to die on an enum
  //    validation error (the NotificationType had no such value), taking the
  //    whole dispatch down with it.
  try {
    await enqueueNotification({
      userId: ctx.supplier.id,
      type: 'BOOKING_CREATED_BY_SUPPLIER',
      title: 'Booking recorded',
      message: `Booking ${booking.bookingNumber} for ${ctx.guestName} was recorded. ${ctx.collectedLabel} recorded as collected, ${ctx.balanceLabel} still to collect.`,
      data: { bookingId: booking.id, origin: ORIGIN },
    });
    result.supplierNotification = true;
  } catch (err) {
    warn('supplier notification', bookingId, err);
  }

  // 2. The guest's confirmation. A guest with no email gets none: the relay is
  //    never faked, and this email is addressed to the person who booked.
  if (ctx.guestEmail) {
    try {
      await enqueueEmail({
        type: 'supplier-created-booking-confirmation',
        bookingId: booking.id,
        data: { bookingId: booking.id },
      });
      result.guestEmail = true;
    } catch (err) {
      warn('guest email', bookingId, err);
    }
  }

  // 3. The supplier's own record, including every notified team member. Sent
  //    even though they created the booking: it is the durable copy with the
  //    guest contact and the commission terms attached.
  if (ctx.supplier.email) {
    try {
      await enqueueEmail({
        type: 'supplier-booking-recorded',
        bookingId: booking.id,
        data: { bookingId: booking.id },
      });
      result.supplierEmail = true;
    } catch (err) {
      warn('supplier email', bookingId, err);
    }
  }

  // 4. A registered customer's in-app bell. Guests have no account, so the
  //    email above is their only channel.
  if (booking.customerId) {
    try {
      await enqueueNotification({
        userId: booking.customerId,
        type: 'BOOKING_CONFIRMED',
        title: 'Booking recorded',
        message: `${ctx.supplier.name || 'Your tour provider'} recorded your booking for "${booking.tour?.title || 'your experience'}". You pay them directly; the platform has not taken any payment.`,
        data: { bookingId: booking.id, origin: ORIGIN },
      });
      result.customerNotification = true;
    } catch (err) {
      warn('customer notification', bookingId, err);
    }
  }

  // 5. Ops. Both are fire-and-forget so neither can delay the response.
  try {
    notifyAdmin({
      type: 'BOOKING_CONFIRMED',
      title: 'Booking Recorded by Supplier',
      message: `Booking #${booking.bookingNumber} — ${ctx.totalLabel} for "${booking.tour?.title || 'a tour'}" was recorded by ${ctx.supplier.name || 'a supplier'} for ${ctx.guestName}. ${ctx.collectedLabel} recorded as collected. Commission applies only to money collected.`,
      data: {
        bookingId: booking.id,
        tourTitle: booking.tour?.title,
        amount: ctx.total,
        supplierId: ctx.supplier.id,
        origin: ORIGIN,
      },
    }).catch((err) => warn('admin notification', bookingId, err));
    result.adminNotification = true;
  } catch (err) {
    warn('admin notification', bookingId, err);
  }

  try {
    const embed = salesBookingRecorded(booking, {
      collected: ctx.collected,
      collectedLabel: ctx.collectedLabel,
      commissionRateLabel: ctx.commissionRateLabel,
    });
    notifyDiscord('sales', embed.content, embed.opts)
      .catch((err) => warn('sales embed', bookingId, err));
    result.salesEmbed = true;
  } catch (err) {
    warn('sales embed', bookingId, err);
  }

  return result;
}

module.exports = {
  notifySupplierBookingCreated,
  // Exported for the unit tests: the message context is the contract the
  // templates render, and it must stay testable without a queue.
  contextOf,
  percentLabel,
};
