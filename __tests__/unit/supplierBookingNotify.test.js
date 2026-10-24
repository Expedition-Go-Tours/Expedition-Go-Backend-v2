/**
 * Post-commit notification fan-out for supplier-created bookings.
 *
 * The rules under test:
 *   - every audience is reached exactly once;
 *   - the money copy never says the platform was paid;
 *   - one failing channel cannot suppress the others or reach the caller.
 */

jest.mock('../../src/core/services/prismaClient', () => ({
  booking: { findUnique: jest.fn() },
}));

jest.mock('../../src/core/services/queue', () => ({
  enqueueEmail: jest.fn(() => Promise.resolve()),
  enqueueNotification: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/adminNotificationService', () => ({
  notifyAdmin: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/discordNotifier', () => ({
  notifyDiscord: jest.fn(() => Promise.resolve()),
}));

const prisma = require('../../src/core/services/prismaClient');
const { enqueueEmail, enqueueNotification } = require('../../src/core/services/queue');
const { notifyAdmin } = require('../../src/core/services/adminNotificationService');
const { notifyDiscord } = require('../../src/core/services/discordNotifier');
const {
  notifySupplierBookingCreated,
  contextOf,
  percentLabel,
} = require('../../src/core/services/supplierBookingNotify');

const BOOKING = {
  id: 'bk_1',
  bookingNumber: 'TRG-2026-0001',
  customerId: 'cus_1',
  customer: { id: 'cus_1', name: 'Ama Mensah', email: 'ama@example.com', phone: '+233201234567' },
  guest: null,
  grossAmount: 400,
  currency: 'USD',
  commissionRate: 0.15,
  commissionPolicy: 'APPLY',
  collections: [
    { amount: 150, status: 'RECORDED' },
    { amount: 50, status: 'RECORDED' },
  ],
  createdAt: new Date('2026-10-24T10:00:00.000Z'),
  tour: {
    id: 'tour_1',
    title: 'Accra Walking Tour',
    slug: 'accra-walking-tour',
    supplier: { id: 'sup_1', name: 'Accra Walks', email: 'ops@accrawalks.com', phone: '+233244000000' },
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  prisma.booking.findUnique.mockResolvedValue(BOOKING);
  enqueueEmail.mockResolvedValue(undefined);
  enqueueNotification.mockResolvedValue(undefined);
  notifyAdmin.mockResolvedValue(undefined);
  notifyDiscord.mockResolvedValue(undefined);
});

describe('contextOf', () => {
  it('reads the money from the collection rows, not the booking total', () => {
    const ctx = contextOf(BOOKING);
    expect(ctx.total).toBe(400);
    expect(ctx.collected).toBe(200);
    expect(ctx.balance).toBe(200);
    expect(ctx.collectedLabel).toBe('$200.00');
    expect(ctx.balanceLabel).toBe('$200.00');
    expect(ctx.commissionRateLabel).toBe('15%');
  });

  it('never reports a negative balance', () => {
    const ctx = contextOf({ ...BOOKING, collections: [{ amount: 500 }] });
    expect(ctx.balance).toBe(0);
  });

  it('counts a corrected collection once, not twice', () => {
    // 150 was reversed and replaced by 50. Summing every row would say 200.
    const ctx = contextOf({
      ...BOOKING,
      collections: [
        { amount: 150, status: 'REVERSED' },
        { amount: 50, status: 'RECORDED' },
      ],
    });
    expect(ctx.collected).toBe(50);
    expect(ctx.balance).toBe(350);
  });

  it('nets refunds out of collected money', () => {
    const ctx = contextOf({
      ...BOOKING,
      collections: [
        { amount: 400, status: 'RECORDED' },
        { amount: -100, status: 'RECORDED' },
      ],
    });
    expect(ctx.collected).toBe(300);
    expect(ctx.balance).toBe(100);
  });

  it('prefers the walk-in guest over the account when both exist', () => {
    const ctx = contextOf({
      ...BOOKING,
      guest: { name: 'Kofi Guest', email: 'kofi@example.com', phone: '+233200000000' },
    });
    expect(ctx.guestName).toBe('Kofi Guest');
    expect(ctx.guestEmail).toBe('kofi@example.com');
  });

  it('labels a fractional rate without floating-point noise', () => {
    expect(percentLabel(0.125)).toBe('12.5%');
    expect(percentLabel(0)).toBe('0%');
    expect(percentLabel(null)).toBe('0%');
  });
});

describe('notifySupplierBookingCreated', () => {
  it('reaches the supplier, the customer, the guest inbox and ops', async () => {
    const result = await notifySupplierBookingCreated('bk_1');

    expect(result).toMatchObject({
      loaded: true,
      supplierNotification: true,
      guestEmail: true,
      supplierEmail: true,
      customerNotification: true,
      adminNotification: true,
      salesEmbed: true,
    });

    const notifications = enqueueNotification.mock.calls.map((call) => call[0]);
    expect(notifications.find((n) => n.type === 'BOOKING_CREATED_BY_SUPPLIER')).toMatchObject({
      userId: 'sup_1',
    });
    expect(notifications.find((n) => n.type === 'BOOKING_CONFIRMED')).toMatchObject({
      userId: 'cus_1',
    });

    const emails = enqueueEmail.mock.calls.map((call) => call[0]);
    expect(emails.map((e) => e.type).sort()).toEqual([
      'supplier-booking-recorded',
      'supplier-created-booking-confirmation',
    ]);

    expect(notifyAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'BOOKING_CONFIRMED', title: 'Booking Recorded by Supplier' }),
    );
    expect(notifyDiscord).toHaveBeenCalledWith(
      'sales',
      expect.stringContaining('recorded by'),
      expect.objectContaining({ title: 'Booking Recorded by Supplier' }),
    );
  });

  it('never tells anyone the platform was paid', async () => {
    await notifySupplierBookingCreated('bk_1');
    const bell = enqueueNotification.mock.calls
      .map((call) => call[0])
      .find((n) => n.type === 'BOOKING_CREATED_BY_SUPPLIER');
    expect(bell.message).toContain('$200.00 recorded as collected');
    expect(bell.message).toContain('$200.00 still to collect');
    expect(bell.message).not.toMatch(/amount paid/i);

    const embed = notifyDiscord.mock.calls[0][2];
    expect(embed.fields.find((f) => f.name === 'Payment').value).toContain('not the platform');
  });

  it('sends no guest email when the booking has no address anywhere', async () => {
    prisma.booking.findUnique.mockResolvedValue({
      ...BOOKING,
      customerId: null,
      customer: null,
    });

    const result = await notifySupplierBookingCreated('bk_1');
    expect(result.guestEmail).toBeUndefined();
    expect(result.customerNotification).toBeUndefined();
    expect(enqueueEmail.mock.calls.map((c) => c[0].type)).toEqual(['supplier-booking-recorded']);
    expect(notifyAdmin).toHaveBeenCalled();
  });

  it('keeps dispatching when one channel throws', async () => {
    enqueueNotification.mockRejectedValueOnce(new Error('redis down'));

    const result = await notifySupplierBookingCreated('bk_1');
    expect(result.loaded).toBe(true);
    expect(result.supplierNotification).toBeUndefined();
    // The customer bell has its own try/catch and still runs.
    expect(result.customerNotification).toBe(true);
    expect(result.guestEmail).toBe(true);
    expect(result.supplierEmail).toBe(true);
    expect(notifyAdmin).toHaveBeenCalled();
    expect(notifyDiscord).toHaveBeenCalled();
  });

  it('resolves quietly when the booking cannot be loaded', async () => {
    prisma.booking.findUnique.mockResolvedValue(null);
    const result = await notifySupplierBookingCreated('bk_missing');
    expect(result).toEqual({ loaded: false });
    expect(enqueueEmail).not.toHaveBeenCalled();
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  it('resolves quietly when the load itself fails', async () => {
    prisma.booking.findUnique.mockRejectedValue(new Error('db down'));
    const result = await notifySupplierBookingCreated('bk_1');
    expect(result).toEqual({ loaded: false });
  });
});
