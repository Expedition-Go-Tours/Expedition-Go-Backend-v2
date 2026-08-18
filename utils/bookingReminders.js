/**
 * Booking reminder scheduler — plans and dispatches time-based booking emails.
 *
 * Two phases (both idempotent, both safe to re-run):
 *   1. planBookingReminders()  — scans eligible bookings and upserts BookingReminder
 *      rows (unique [bookingId, type]), so every reminder is planned exactly once.
 *   2. dispatchDueReminders()  — finds planned reminders whose scheduledFor has
 *      arrived, sends the email via the queue, then marks them SENT / FAILED.
 *
 * Types planned:
 *   PAYMENT_DUE_24H          — reserve-now-pay-later, still unpaid: remind customer
 *                              that the card will be charged (24h before the activity).
 *   BOOKING_24H              — confirmed upcoming booking: customer reminder.
 *   SUPPLIER_BOOKING_24H     — confirmed upcoming booking: supplier reminder.
 *   PICKUP_LOCATION_REQUIRED — tour offers pickup but no location chosen yet:
 *                              remind the customer to add it (72h before).
 *   REVIEW_REQUEST           — completed booking: invite customer to review (48h
 *                              after the activity date).
 *
 * All emails go through the queue (typed jobs → emailService), so failures retry
 * with backoff and Redis-unavailable mode falls back to direct send.
 */

const { enqueueEmail } = require('./queue');
const prisma = require('./prismaClient');

const BOOKING_24H_BEFORE_HOURS = 24;
const PICKUP_REQUIRED_HOURS = 72;
const REVIEW_REQUEST_HOURS_AFTER = 48;

/**
 * Scan for bookings that need reminders planned. Creates BookingReminder rows
 * only when they do not already exist (unique [bookingId, type]).
 */
async function planBookingReminders() {
  const now = new Date();
  const in24h = new Date(now.getTime() + BOOKING_24H_BEFORE_HOURS * 60 * 60 * 1000);
  const in72h = new Date(now.getTime() + PICKUP_REQUIRED_HOURS * 60 * 60 * 1000);

  const upcoming = await prisma.booking.findMany({
    where: {
      // Pay-later bookings stay PENDING until the deferred charge settles, so
      // reminders must plan for them regardless of status.
      OR: [{ status: 'CONFIRMED' }, { paymentTiming: 'later' }],
      selectedDate: { gte: now, lte: in72h },
    },
    select: {
      id: true,
      paymentTiming: true,
      paymentStatus: true,
      selectedDate: true,
      pickup: true,
      tour: {
        select: {
          bookingAndTickets: true,
          supplier: { select: { id: true } },
        },
      },
    },
  });

  const reminders = [];
  for (const booking of upcoming) {
    const date = booking.selectedDate;

    // 24h-before reminders (both customer + supplier)
    if (date <= in24h) {
      reminders.push({
        bookingId: booking.id,
        type: 'BOOKING_24H',
        scheduledFor: new Date(date.getTime() - BOOKING_24H_BEFORE_HOURS * 60 * 60 * 1000),
      });
      reminders.push({
        bookingId: booking.id,
        type: 'SUPPLIER_BOOKING_24H',
        scheduledFor: new Date(date.getTime() - BOOKING_24H_BEFORE_HOURS * 60 * 60 * 1000),
      });
    }

    // Pay-later payment reminder (24h before the charge window / activity)
    if (booking.paymentTiming === 'later' && booking.paymentStatus === 'PENDING') {
      reminders.push({
        bookingId: booking.id,
        type: 'PAYMENT_DUE_24H',
        scheduledFor: new Date(date.getTime() - BOOKING_24H_BEFORE_HOURS * 60 * 60 * 1000),
      });
    }

    // Pickup location still required (tour offers pickup but none chosen)
    const ticket = booking.tour?.bookingAndTickets || {};
    const offersPickup = !!ticket.pickupProvided;
    if (offersPickup && !booking.pickup) {
      reminders.push({
        bookingId: booking.id,
        type: 'PICKUP_LOCATION_REQUIRED',
        scheduledFor: new Date(date.getTime() - PICKUP_REQUIRED_HOURS * 60 * 60 * 1000),
      });
    }
  }

  if (reminders.length === 0) return { planned: 0 };

  // Upsert each reminder — unique [bookingId, type] makes re-plans a no-op.
  let planned = 0;
  for (const reminder of reminders) {
    try {
      const result = await prisma.bookingReminder.upsert({
        where: {
          bookingId_type: { bookingId: reminder.bookingId, type: reminder.type },
        },
        create: reminder,
        update: {}, // never reschedule once planned
      });
      if (result) planned += 1;
    } catch (err) {
      console.error(`[Reminders] Plan ${reminder.type} for booking ${reminder.bookingId} failed:`, err.message);
    }
  }

  // Review requests for completed bookings (48h after the activity date).
  const reviewDue = await prisma.booking.findMany({
    where: {
      status: 'COMPLETED',
      selectedDate: { lte: new Date(now.getTime() - REVIEW_REQUEST_HOURS_AFTER * 60 * 60 * 1000) },
      review: { none: {} },
    },
    select: { id: true, selectedDate: true },
  });
  for (const booking of reviewDue) {
    try {
      await prisma.bookingReminder.upsert({
        where: { bookingId_type: { bookingId: booking.id, type: 'REVIEW_REQUEST' } },
        create: {
          bookingId: booking.id,
          type: 'REVIEW_REQUEST',
          scheduledFor: new Date(booking.selectedDate.getTime() + REVIEW_REQUEST_HOURS_AFTER * 60 * 60 * 1000),
        },
        update: {},
      });
      planned += 1;
    } catch (err) {
      console.error(`[Reminders] Plan REVIEW_REQUEST for booking ${booking.id} failed:`, err.message);
    }
  }

  return { planned };
}

/**
 * Find due reminders (PENDING + scheduledFor <= now) and send their emails.
 */
async function dispatchDueReminders() {
  const due = await prisma.bookingReminder.findMany({
    where: { status: 'PENDING', scheduledFor: { lte: new Date() } },
    orderBy: { scheduledFor: 'asc' },
    take: 200,
  });

  let sent = 0;
  let failed = 0;
  for (const reminder of due) {
    const email = emailForReminder(reminder.type, reminder.bookingId);
    if (!email) {
      await markReminder(reminder.id, 'SKIPPED', 'No email type mapped');
      failed += 1;
      continue;
    }
    try {
      await enqueueEmail(email);
      await markReminder(reminder.id, 'SENT');
      sent += 1;
    } catch (err) {
      console.error(`[Reminders] Dispatch ${reminder.type} for booking ${reminder.bookingId} failed:`, err.message);
      await markReminder(reminder.id, 'FAILED', err.message);
      failed += 1;
    }
  }

  return { due: due.length, sent, failed };
}

/**
 * Map a reminder type to the typed queue email job it should send.
 */
function emailForReminder(type, bookingId) {
  switch (type) {
    case 'BOOKING_24H':
      return { type: 'booking-reminder', bookingId };
    case 'SUPPLIER_BOOKING_24H':
      return { type: 'supplier-booking-reminder', bookingId };
    case 'PAYMENT_DUE_24H':
      return { type: 'payment-reminder', bookingId };
    case 'PICKUP_LOCATION_REQUIRED':
      return { type: 'pickup-location-required', bookingId };
    case 'REVIEW_REQUEST':
      return { type: 'review-request', bookingId };
    default:
      return null;
  }
}

async function markReminder(id, status, error = null) {
  try {
    await prisma.bookingReminder.update({
      where: { id },
      data: {
        status,
        error: error || null,
        sentAt: status === 'SENT' ? new Date() : undefined,
      },
    });
  } catch (err) {
    console.error(`[Reminders] Mark ${id} ${status} failed:`, err.message);
  }
}

module.exports = { planBookingReminders, dispatchDueReminders };