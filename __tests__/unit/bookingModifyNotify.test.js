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

const { notifyModificationApplied } = require('../../utils/bookingModify');
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

