/**
 * Reminder planning — timing is anchored to the pay-later charge moment.
 *
 * The card is charged at payLaterChargeAt(travelDate) (T-24h). The payment
 * reminder must land a lead BEFORE that, not alongside it, otherwise the
 * "we will charge you on <date>" notice races the charge it warns about.
 *
 * These tests pin the planned `scheduledFor` values so the anchor can never
 * silently drift back to the activity date.
 */
jest.mock('../../src/core/services/queue', () => ({ enqueueEmail: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/core/services/adminNotificationService', () => ({ notifyAdmin: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/core/services/prismaClient', () => ({
  booking: { findMany: jest.fn() },
  bookingReminder: { upsert: jest.fn(() => Promise.resolve({ id: 'r1' })) },
}));

const { planBookingReminders } = require('../../src/core/services/bookingReminders');
const prisma = require('../../src/core/services/prismaClient');

const H = 60 * 60 * 1000;
const now = Date.now();
const hours = (h) => new Date(now + h * H);

const laterBooking = (travelDate) => ({
  id: 'b1',
  status: 'PENDING',
  paymentTiming: 'later',
  paymentStatus: 'PENDING',
  travelDate,
  pickup: null,
  tour: { bookingAndTickets: {}, supplier: { id: 's1' } },
});

/** Planned reminders of a given type, from the upsert create payloads. */
const planned = (type) =>
  prisma.bookingReminder.upsert.mock.calls
    .map((call) => call[0].create)
    .filter((r) => r && r.type === type);

describe('planBookingReminders timing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.PAY_LATER_CHARGE_BEFORE_HOURS;
    prisma.bookingReminder.upsert.mockResolvedValue({ id: 'r1' });
    // first findMany → upcoming reminders; second → review-due (none)
    prisma.booking.findMany.mockResolvedValueOnce([]);
  });

  it('schedules the payment reminder a lead before the deferred charge', async () => {
    const travel = hours(72);
    prisma.booking.findMany.mockReset();
    prisma.booking.findMany.mockResolvedValueOnce([laterBooking(travel)]).mockResolvedValueOnce([]);

    await planBookingReminders();

    const [reminder] = planned('PAYMENT_DUE_24H');
    expect(reminder).toBeDefined();
    // charge is travel − 24h, reminder lead is a further 24h → travel − 48h
    expect(reminder.scheduledFor.getTime()).toBeCloseTo(travel.getTime() - 48 * H, -3);
    // and strictly before the charge
    expect(reminder.scheduledFor.getTime()).toBeLessThan(travel.getTime() - 24 * H);
  });

  it('moves the reminder with PAY_LATER_CHARGE_BEFORE_HOURS', async () => {
    process.env.PAY_LATER_CHARGE_BEFORE_HOURS = '12';
    const travel = hours(72);
    prisma.booking.findMany.mockReset();
    prisma.booking.findMany.mockResolvedValueOnce([laterBooking(travel)]).mockResolvedValueOnce([]);

    await planBookingReminders();

    const [reminder] = planned('PAYMENT_DUE_24H');
    // charge at travel − 12h, reminder 24h earlier → travel − 36h
    expect(reminder.scheduledFor.getTime()).toBeCloseTo(travel.getTime() - 36 * H, -3);
  });

  it('leaves the plain 24h booking reminder anchored to the activity date', async () => {
    const travel = hours(20);
    prisma.booking.findMany.mockReset();
    prisma.booking.findMany.mockResolvedValueOnce([laterBooking(travel)]).mockResolvedValueOnce([]);

    await planBookingReminders();

    const [customerReminder] = planned('BOOKING_24H');
    expect(customerReminder.scheduledFor.getTime()).toBeCloseTo(travel.getTime() - 24 * H, -3);
  });
});
