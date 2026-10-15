/**
 * Reminder dispatch recheck — the world changes between planning and firing.
 *
 * planBookingReminders() runs up to 72h ahead and deliberately includes
 * reserve-now-pay-later bookings (status PENDING, paymentStatus PENDING).
 * dispatchDueReminders() used to send whatever it found due with no re-check
 * of the live booking — only REVIEW_REQUEST revalidated. Consequences:
 *
 *   - BOOKING_24H / SUPPLIER_BOOKING_24H target T-24h, the same moment the
 *     pay-later sweep charges the card. The reminder could fire for a booking
 *     that was never paid (charge failed, or the sweep had not run yet).
 *   - PICKUP_LOCATION_REQUIRED fires at T-72h — always pre-payment for
 *     pay-later (minimum lead time is 48h).
 *   - PAYMENT_DUE_24H ("your card will be charged") kept firing after the
 *     charge had already landed.
 *   - Nothing cancelled BookingReminder rows on cancellation (no
 *     bookingReminder.delete anywhere in src/), so reminders fired for
 *     cancelled bookings too.
 *
 * These tests pin the dispatch-time recheck: cancelled bookings skip, unpaid
 * pay-later bookings skip every type except the payment-due notice, a paid
 * booking sends normally, and the pickup nudge re-arms once past the charge
 * window instead of dying pre-payment.
 */
jest.mock('../../src/core/services/queue', () => ({
  enqueueEmail: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/adminNotificationService', () => ({
  notifyAdmin: jest.fn(() => Promise.resolve({ success: true })),
}));
jest.mock('../../src/core/services/prismaClient', () => ({
  booking: { findUnique: jest.fn() },
  bookingReminder: {
    findMany: jest.fn(),
    update: jest.fn(() => Promise.resolve()),
  },
}));

const { dispatchDueReminders } = require('../../src/core/services/bookingReminders');
const { enqueueEmail } = require('../../src/core/services/queue');
const { notifyAdmin } = require('../../src/core/services/adminNotificationService');
const prisma = require('../../src/core/services/prismaClient');

const now = Date.now();
const hours = (h) => new Date(now + h * 60 * 60 * 1000);

const dueReminder = (type, overrides = {}) => ({
  id: `r-${type}`,
  bookingId: 'b1',
  type,
  status: 'PENDING',
  scheduledFor: new Date(now - 1000),
  ...overrides,
});

/** booking state as dispatch's recheck sees it */
const liveBooking = (overrides = {}) => ({
  status: 'CONFIRMED',
  paymentTiming: 'now',
  paymentStatus: 'SUCCEEDED',
  travelDate: hours(24),
  ...overrides,
});

describe('dispatchDueReminders rechecks the booking before sending', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.bookingReminder.update.mockResolvedValue({});
  });

  it('sends normally for a live, paid booking', async () => {
    prisma.bookingReminder.findMany.mockResolvedValue([dueReminder('BOOKING_24H')]);
    prisma.booking.findUnique.mockResolvedValue(liveBooking());

    const result = await dispatchDueReminders();

    expect(enqueueEmail).toHaveBeenCalledWith({ type: 'booking-reminder', bookingId: 'b1' });
    expect(prisma.bookingReminder.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SENT' }) })
    );
    expect(result.sent).toBe(1);
  });

  it('skips every reminder for a cancelled booking', async () => {
    prisma.bookingReminder.findMany.mockResolvedValue([
      dueReminder('BOOKING_24H'),
      dueReminder('SUPPLIER_BOOKING_24H'),
      dueReminder('PICKUP_LOCATION_REQUIRED'),
      dueReminder('PAYMENT_DUE_24H'),
    ]);
    prisma.booking.findUnique.mockResolvedValue(
      liveBooking({ status: 'CANCELLED', paymentStatus: 'REFUNDED' })
    );

    const result = await dispatchDueReminders();

    expect(enqueueEmail).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
    for (const call of prisma.bookingReminder.update.mock.calls) {
      expect(call[0].data).toMatchObject({ status: 'SKIPPED', error: 'Booking cancelled' });
    }
  });

  it('skips the 24h customer + supplier reminders for an uncharged pay-later booking', async () => {
    prisma.bookingReminder.findMany.mockResolvedValue([
      dueReminder('BOOKING_24H'),
      dueReminder('SUPPLIER_BOOKING_24H'),
    ]);
    prisma.booking.findUnique.mockResolvedValue(
      liveBooking({ status: 'PENDING', paymentTiming: 'later', paymentStatus: 'PENDING' })
    );

    const result = await dispatchDueReminders();

    expect(enqueueEmail).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
    for (const call of prisma.bookingReminder.update.mock.calls) {
      expect(call[0].data).toMatchObject({
        status: 'SKIPPED',
        error: 'Pay-later booking not charged yet',
      });
    }
  });

  it('still sends the payment-due notice for an uncharged pay-later booking', async () => {
    // This reminder exists precisely to talk about the upcoming charge.
    prisma.bookingReminder.findMany.mockResolvedValue([dueReminder('PAYMENT_DUE_24H')]);
    prisma.booking.findUnique.mockResolvedValue(
      liveBooking({ status: 'PENDING', paymentTiming: 'later', paymentStatus: 'PENDING' })
    );

    await dispatchDueReminders();

    expect(enqueueEmail).toHaveBeenCalledWith({ type: 'payment-reminder', bookingId: 'b1' });
  });

  it('skips the payment-due notice once the charge has landed', async () => {
    prisma.bookingReminder.findMany.mockResolvedValue([dueReminder('PAYMENT_DUE_24H')]);
    prisma.booking.findUnique.mockResolvedValue(
      liveBooking({ paymentTiming: 'later', paymentStatus: 'SUCCEEDED' })
    );

    const result = await dispatchDueReminders();

    expect(enqueueEmail).not.toHaveBeenCalled();
    expect(prisma.bookingReminder.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ error: 'Already charged' }) })
    );
    expect(result.sent).toBe(0);
  });

  it('re-arms the pickup nudge past the charge window instead of losing it', async () => {
    prisma.bookingReminder.findMany.mockResolvedValue([dueReminder('PICKUP_LOCATION_REQUIRED')]);
    prisma.booking.findUnique.mockResolvedValue(
      liveBooking({ status: 'PENDING', paymentTiming: 'later', paymentStatus: 'PENDING', travelDate: hours(72) })
    );

    await dispatchDueReminders();

    // Not sent now…
    expect(enqueueEmail).not.toHaveBeenCalled();
    // …but rescheduled to travelDate−20h, after the T-24h charge (72h out
    // minus 20h = 52h from now).
    expect(prisma.bookingReminder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'r-PICKUP_LOCATION_REQUIRED' },
        data: { scheduledFor: expect.any(Date) },
      })
    );
    const rescheduled = prisma.bookingReminder.update.mock.calls[0][0].data.scheduledFor;
    expect(rescheduled.getTime()).toBeCloseTo(hours(52).getTime(), -3);
  });

  it('skips the pickup nudge when the re-arm point is already behind us (no loop)', async () => {
    // Second pass: travelDate is 19h away, so T-20h has passed. The reminder
    // must terminate as SKIPPED rather than reschedule again.
    prisma.bookingReminder.findMany.mockResolvedValue([dueReminder('PICKUP_LOCATION_REQUIRED')]);
    prisma.booking.findUnique.mockResolvedValue(
      liveBooking({ status: 'PENDING', paymentTiming: 'later', paymentStatus: 'PENDING', travelDate: hours(19) })
    );

    const result = await dispatchDueReminders();

    expect(enqueueEmail).not.toHaveBeenCalled();
    // Exactly one update — the SKIPPED mark, not a reschedule.
    expect(prisma.bookingReminder.update).toHaveBeenCalledTimes(1);
    expect(prisma.bookingReminder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SKIPPED', error: 'Pay-later booking not charged yet' }),
      })
    );
    expect(result.sent).toBe(0);
  });

  it('skips cleanly when the booking row is gone', async () => {
    prisma.bookingReminder.findMany.mockResolvedValue([dueReminder('BOOKING_24H')]);
    prisma.booking.findUnique.mockResolvedValue(null);

    const result = await dispatchDueReminders();

    expect(enqueueEmail).not.toHaveBeenCalled();
    expect(prisma.bookingReminder.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ error: 'Booking no longer exists' }) })
    );
    expect(result.sent).toBe(0);
  });

  it('tells the admin the CHARGE date (travel − 24h), not the activity date', async () => {
    prisma.bookingReminder.findMany.mockResolvedValue([dueReminder('PAYMENT_DUE_24H')]);
    prisma.booking.findUnique
      // dispatch gate re-check
      .mockResolvedValueOnce(liveBooking({ paymentTiming: 'later', paymentStatus: 'PENDING', travelDate: hours(48) }))
      // admin-alert lookup
      .mockResolvedValueOnce({
        bookingNumber: 'LAT-9',
        grossAmount: 175,
        travelDate: hours(48),
        tour: { title: 'Safari' },
      });

    await dispatchDueReminders();

    const chargeAt = new Date(hours(48).getTime() - 24 * 60 * 60 * 1000);
    const expected = chargeAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const travel = hours(48).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    expect(notifyAdmin).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'PAYMENT_UPCOMING',
        message: expect.stringContaining(`charged on ${expected}`),
      })
    );
    // The two must be distinguishable for the assertion to mean anything.
    expect(expected).not.toBe(travel);
  });
});
