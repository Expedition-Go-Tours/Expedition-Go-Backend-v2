/**
 * Verifies that applying a booking modification notifies the supplier with a
 * VALID NotificationType and emails both the customer and supplier — the two
 * channels operators rely on when a confirmed booking changes.
 */
jest.mock('../../utils/queue', () => ({
  enqueueEmail: jest.fn(() => Promise.resolve()),
  enqueueNotification: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../utils/adminNotificationService', () => ({
  notifyAdmin: jest.fn(() => Promise.resolve({ success: true })),
}));

jest.mock('../../utils/prismaClient', () => ({
  booking: { findUnique: jest.fn() },
}));

const { notifyModificationApplied, buildChangeLabels } = require('../../utils/bookingModify');
const { enqueueEmail, enqueueNotification } = require('../../utils/queue');
const { notifyAdmin } = require('../../utils/adminNotificationService');
const prisma = require('../../utils/prismaClient');

describe('bookingModify supplier notification on apply', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('tells the supplier + admin WHICH fields changed (in-app) and emails both parties', async () => {
    prisma.booking.findUnique.mockResolvedValue({
      id: 'b1',
      bookingNumber: 'EXP-1',
      source: 'EXPEDITION',
      customerId: 'u1',
      tour: { supplierId: 's1', title: 'Sunset Safari' },
    });

    await notifyModificationApplied('b1', {
      changes: [{ label: 'Travellers', detail: '1 → 2' }],
      previousTotal: 100,
      newTotal: 120,
      adjustment: 20,
      previousPayout: 85,
      newPayout: 102,
      payoutAdjustment: 17,
    });

    expect(enqueueEmail).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'customer-booking-changed', bookingId: 'b1' })
    );
    expect(enqueueEmail).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'supplier-booking-changed', bookingId: 'b1' })
    );

    // Supplier bell: valid type + which field changed in the message + data.
    expect(enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 's1',
        type: 'BOOKING_MODIFIED',
        title: 'Booking Updated',
        message: 'Booking #EXP-1 was updated — Travellers: 1 → 2',
      })
    );
    const supplierCall = enqueueNotification.mock.calls[0][0];
    expect(supplierCall.data).toMatchObject({
      bookingId: 'b1',
      changeSummary: 'Travellers: 1 → 2',
      changes: [{ label: 'Travellers', detail: '1 → 2' }],
      newTotal: 120,
      adjustment: 20,
    });

    // Admin ops bell: same field detail.
    expect(notifyAdmin).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'BOOKING_MODIFIED',
        title: 'Booking Modified by Customer',
        message: 'Booking #EXP-1 for "Sunset Safari" was updated — Travellers: 1 → 2',
      })
    );
  });

  it('skips the supplier in-app notification when there is no supplier (admin still notified)', async () => {
    prisma.booking.findUnique.mockResolvedValue({
      id: 'b1',
      bookingNumber: 'EXP-2',
      source: 'EXPEDITION',
      customerId: 'u1',
      tour: null,
    });

    await notifyModificationApplied('b1', {
      changes: [],
      previousTotal: 100,
      newTotal: 100,
      adjustment: 0,
    });

    expect(enqueueEmail).toHaveBeenCalledTimes(2);
    expect(enqueueNotification).not.toHaveBeenCalled();
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
  });
});

describe('buildChangeLabels', () => {
  it('emits previous/updated values for every row and a Total price row when money changes', () => {
    const rows = buildChangeLabels(
      {
        travelDate: new Date(Date.UTC(2026, 0, 1)),
        selectedTime: '09:00',
        travelerTotal: 1,
        grossAmount: 100,
      },
      {
        travelDate: new Date(Date.UTC(2026, 0, 2)),
        selectedTime: '10:00',
        travelerTotal: 2,
        newTotal: 185,
      },
      'USD'
    );

    expect(rows).toEqual([
      expect.objectContaining({ label: 'Activity date', previous: '2026-01-01', updated: '2026-01-02' }),
      expect.objectContaining({ label: 'Start time', previous: '09:00', updated: '10:00' }),
      expect.objectContaining({ label: 'Travellers', previous: '1', updated: '2' }),
      expect.objectContaining({ label: 'Total price', previous: '$100.00', updated: '$185.00' }),
    ]);
  });

  it('omits the Total price row when the amount is unchanged', () => {
    const rows = buildChangeLabels(
      { travelDate: new Date(Date.UTC(2026, 0, 1)), selectedTime: '09:00', travelerTotal: 2, grossAmount: 100 },
      { travelDate: new Date(Date.UTC(2026, 0, 2)), selectedTime: '09:00', travelerTotal: 2, newTotal: 100 },
      'USD'
    );

    expect(rows.some((r) => r.label === 'Total price')).toBe(false);
    expect(rows.some((r) => r.label === 'Activity date')).toBe(true);
  });
});

