jest.mock('uuid', () => ({ v4: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }));

const mockUpsert = jest.fn();
jest.mock('../../utils/prismaClient', () => ({
  booking: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn(), aggregate: jest.fn() },
  $transaction: jest.fn((cb) => cb({ bookingCounter: { upsert: mockUpsert } })),
  $queryRaw: jest.fn(),
}));

jest.mock('../../utils/getConfig', () => jest.fn().mockResolvedValue('2.50'));

const prisma = require('../../utils/prismaClient');

const {
  generateBookingNumber,
  validateTravelerInfo,
  calculateBookingTotals,
  checkBookingConflicts,
  getBookingStats,
  generateBookingConfirmation,
  canModifyBooking,
  evaluateCancellationPolicy,
  calculateRefundAmount,
  getUpcomingBookings,
} = require('../../utils/bookingHelpers');

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// generateBookingNumber
// ---------------------------------------------------------------------------
describe('generateBookingNumber', () => {
  it('generates a booking number with TRA prefix, timestamp, year, and counter', async () => {
    mockUpsert.mockResolvedValue({ prefix: 'TRA', year: 2026, count: 1 });
    const result = await generateBookingNumber();
    expect(result).toMatch(/^TRA-\d{8}-2026-\d{2}$/);
  });

  it('increments counter on each call', async () => {
    mockUpsert
      .mockResolvedValueOnce({ prefix: 'TRA', year: 2026, count: 1 })
      .mockResolvedValueOnce({ prefix: 'TRA', year: 2026, count: 2 });
    const r1 = await generateBookingNumber();
    const r2 = await generateBookingNumber();
    expect(r1).toMatch(/-01$/);
    expect(r2).toMatch(/-02$/);
  });

  it('accepts a custom prefix for expedition bookings', async () => {
    mockUpsert.mockResolvedValue({ prefix: 'EXP', year: 2026, count: 1 });
    const result = await generateBookingNumber('EXP');
    expect(result).toMatch(/^EXP-\d{8}-2026-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// validateTravelerInfo
// ---------------------------------------------------------------------------
describe('validateTravelerInfo', () => {
  it('returns error for null/undefined/string input', () => {
    expect(validateTravelerInfo(null).isValid).toBe(false);
    expect(validateTravelerInfo('string').isValid).toBe(false);
    expect(validateTravelerInfo(42).isValid).toBe(false);
  });

  it('returns error for no travelers', () => {
    const result = validateTravelerInfo({ phoneNumber: '+1234567890', location: 'NYC' });
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('At least one traveler is required');
  });

  it('returns error for invalid phone', () => {
    const result = validateTravelerInfo({ adults: 1, phoneNumber: 'x', location: 'NYC' });
    expect(result.errors).toContain('A valid phone number is required. Use international format (e.g., +12025551234)');
  });

  it('returns error for short location', () => {
    const result = validateTravelerInfo({ adults: 1, phoneNumber: '+12025551234', location: 'A' });
    expect(result.errors).toContain('Your location (city/country) is required');
  });

  it('returns valid for complete traveler info', () => {
    const result = validateTravelerInfo({ adults: 2, children: 1, phoneNumber: '+12025551234', location: 'New York, USA' });
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.totalTravelers).toBe(3);
  });

  it('counts youth travelers', () => {
    const result = validateTravelerInfo({ youth: 1, phoneNumber: '+12025551234', location: 'London' });
    expect(result.totalTravelers).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// calculateBookingTotals
// ---------------------------------------------------------------------------
describe('calculateBookingTotals', () => {
  it('calculates totals for USD with default tax and fee', async () => {
    const result = await calculateBookingTotals(100, 'USD');
    expect(result.subtotal).toBe(100);
    expect(result.taxes).toBe(8);
    expect(result.fees).toBe(2.5);
    expect(result.discount).toBe(0);
    expect(result.total).toBe(110.5);
    expect(result.currency).toBe('USD');
  });

  it('applies EUR tax rate', async () => {
    const result = await calculateBookingTotals(100, 'EUR');
    expect(result.taxes).toBe(20);
  });

  it('applies GBP tax rate', async () => {
    const result = await calculateBookingTotals(100, 'GBP');
    expect(result.taxes).toBe(20);
  });

  it('applies CAD tax rate', async () => {
    const result = await calculateBookingTotals(100, 'CAD');
    expect(result.taxes).toBe(13);
  });

  it('uses 0 tax rate for unknown currency', async () => {
    const result = await calculateBookingTotals(100, 'JPY');
    expect(result.taxes).toBe(0);
  });

  it('applies 10% discount for promo code', async () => {
    const result = await calculateBookingTotals(200, 'USD', 'PROMO10');
    expect(result.discount).toBe(20);
    expect(result.total).toBe(200 + 16 + 2.5 - 20);
  });

  it('rounds to 2 decimal places', async () => {
    const result = await calculateBookingTotals(99.99, 'USD');
    expect(result.total).toBeCloseTo(110.49, 2);
  });
});

// ---------------------------------------------------------------------------
// checkBookingConflicts
// ---------------------------------------------------------------------------
describe('checkBookingConflicts', () => {
  it('returns hasConflicts false when no conflicts', async () => {
    prisma.booking.findMany.mockResolvedValue([]);
    const result = await checkBookingConflicts('s1', '2026-06-15');
    expect(result.hasConflicts).toBe(false);
    expect(result.conflicts).toEqual([]);
  });

  it('returns hasConflicts true when conflicts exist', async () => {
    prisma.booking.findMany.mockResolvedValue([{ id: 'b1' }]);
    const result = await checkBookingConflicts('s1', '2026-06-15');
    expect(result.hasConflicts).toBe(true);
  });

  it('includes selectedTime in query when provided', async () => {
    prisma.booking.findMany.mockResolvedValue([]);
    await checkBookingConflicts('s1', '2026-06-15', '10:00');
    expect(prisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ selectedTime: '10:00' }),
      })
    );
  });

  it('excludes specified booking id', async () => {
    prisma.booking.findMany.mockResolvedValue([]);
    await checkBookingConflicts('s1', '2026-06-15', null, 'b1');
    expect(prisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { not: 'b1' } }),
      })
    );
  });

  it('handles errors gracefully', async () => {
    prisma.booking.findMany.mockRejectedValue(new Error('DB error'));
    const result = await checkBookingConflicts('s1', '2026-06-15');
    expect(result.hasConflicts).toBe(false);
    expect(result.conflicts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getBookingStats
// ---------------------------------------------------------------------------
describe('getBookingStats', () => {
  it('returns booking stats with revenue data', async () => {
    const mockGroupBy = [{ status: 'CONFIRMED', _count: 5 }];
    const mockAgg = { _sum: { total: 10000, supplierPayout: 8000, commissionAmount: 2000 }, _avg: { total: 200 } };
    const mockDaily = [{ date: '2026-01-01', bookings: 2, revenue: 400 }];
    prisma.booking.count.mockResolvedValue(10);
    prisma.booking.groupBy.mockResolvedValue(mockGroupBy);
    prisma.booking.aggregate.mockResolvedValue(mockAgg);
    prisma.$queryRaw.mockResolvedValue(mockDaily);

    const result = await getBookingStats(null, '2026-01-01', '2026-12-31');

    expect(result.totalBookings).toBe(10);
    expect(result.bookingsByStatus).toEqual(mockGroupBy);
    expect(result.revenue.total).toBe(10000);
    expect(result.revenue.supplierPayout).toBe(8000);
    expect(result.revenue.commission).toBe(2000);
    expect(result.revenue.average).toBe(200);
    expect(result.dailyTrend).toEqual(mockDaily);
  });

  it('includes supplierId filter when provided', async () => {
    prisma.booking.count.mockResolvedValue(0);
    prisma.booking.groupBy.mockResolvedValue([]);
    prisma.booking.aggregate.mockResolvedValue({ _sum: { total: null, supplierPayout: null, commissionAmount: null }, _avg: { total: null } });
    prisma.$queryRaw.mockResolvedValue([]);

    const result = await getBookingStats('s1', '2026-01-01', '2026-12-31');

    expect(prisma.booking.count).toHaveBeenCalled();
    expect(result.totalBookings).toBe(0);
  });

  it('throws error when prisma fails', async () => {
    prisma.booking.count.mockRejectedValue(new Error('DB error'));
    await expect(getBookingStats(null, '2026-01-01', '2026-12-31')).rejects.toThrow('DB error');
  });
});

// ---------------------------------------------------------------------------
// generateBookingConfirmation
// ---------------------------------------------------------------------------
describe('generateBookingConfirmation', () => {
  it('generates confirmation object', () => {
    const booking = { bookingNumber: 'TB001', selectedDate: new Date('2026-06-15'), selectedTime: '10:00', travelers: { adults: 2 }, subtotal: 100, taxes: 8, fees: 2.5, total: 110.5, currency: 'USD', specialRequests: 'None', status: 'CONFIRMED', createdAt: new Date() };
    const tour = { title: 'Amazing Tour', supplier: { name: 'Supplier Co' }, photos: ['photo1.jpg'] };
    const customer = { name: 'John Doe', email: 'john@test.com' };
    const result = generateBookingConfirmation(booking, tour, customer);
    expect(result.bookingNumber).toBe('TB001');
    expect(result.customer.name).toBe('John Doe');
    expect(result.tour.title).toBe('Amazing Tour');
    expect(result.schedule.date).toEqual(booking.selectedDate);
    expect(result.pricing.total).toBe(110.5);
  });
});

// ---------------------------------------------------------------------------
// canModifyBooking
// ---------------------------------------------------------------------------
describe('canModifyBooking', () => {
  const futureBooking = { status: 'CONFIRMED', selectedDate: new Date(Date.now() + 48 * 60 * 60 * 1000) };
  const completedBooking = { status: 'COMPLETED', selectedDate: new Date() };
  const nearFutureBooking = { status: 'CONFIRMED', selectedDate: new Date(Date.now() + 2 * 60 * 60 * 1000) };

  it('allows modification for future bookings outside cutoff', () => {
    const result = canModifyBooking(futureBooking, { bookingAndTickets: { modificationCutoffHours: 24 } });
    expect(result.canModify).toBe(true);
    expect(result.reason).toBeNull();
  });

  it('blocks modification for completed/cancelled/refunded bookings', () => {
    for (const status of ['COMPLETED', 'CANCELLED', 'REFUNDED']) {
      const result = canModifyBooking({ ...completedBooking, status }, {});
      expect(result.canModify).toBe(false);
      expect(result.reason).toBe('Booking cannot be modified in current status');
    }
  });

  it('blocks modification within cutoff hours', () => {
    const result = canModifyBooking(nearFutureBooking, { bookingAndTickets: { modificationCutoffHours: 24 } });
    expect(result.canModify).toBe(false);
  });

  it('defaults to 24h cutoff when not configured', () => {
    const result = canModifyBooking(futureBooking, {});
    expect(result.canModify).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// calculateRefundAmount
// ---------------------------------------------------------------------------
describe('calculateRefundAmount', () => {
  const longLeadBooking = { total: '500', selectedDate: new Date(Date.now() + 72 * 60 * 60 * 1000) };
  const shortLeadBooking = { total: '500', selectedDate: new Date(Date.now() + 6 * 60 * 60 * 1000) };

  it('returns full refund for >24h lead with no policy', () => {
    const result = calculateRefundAmount(longLeadBooking, {});
    expect(result.refundAmount).toBe(500);
    expect(result.refundPercentage).toBe(100);
  });

  it('returns no refund for <24h lead with no policy', () => {
    const result = calculateRefundAmount(shortLeadBooking, {});
    expect(result.refundAmount).toBe(0);
    expect(result.refundPercentage).toBe(0);
  });

  it('respects tour-specific cancellation policy window', () => {
    const tour = { bookingAndTickets: { cancellationPolicy: { cancellationWindowHours: 48 } } };
    const result = calculateRefundAmount(longLeadBooking, tour);
    expect(result.refundAmount).toBe(500);
    expect(result.refundPercentage).toBe(100);
  });

  it('returns no refund when within cancellation window', () => {
    const tour = { bookingAndTickets: { cancellationPolicy: { cancellationWindowHours: 48 } } };
    const result = calculateRefundAmount(shortLeadBooking, tour);
    expect(result.refundAmount).toBe(0);
    expect(result.refundPercentage).toBe(0);
  });

  it('defaults cancellation window to 24h', () => {
    const tour = { bookingAndTickets: { cancellationPolicy: {} } };
    const result = calculateRefundAmount(shortLeadBooking, tour);
    expect(result.refundAmount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// evaluateCancellationPolicy
// ---------------------------------------------------------------------------
describe('evaluateCancellationPolicy', () => {
  const longLeadBooking = { total: '500', selectedDate: new Date(Date.now() + 72 * 60 * 60 * 1000) };
  const shortLeadBooking = { total: '500', selectedDate: new Date(Date.now() + 6 * 60 * 60 * 1000) };

  it('returns allowed + full refund for >24h lead with no policy', () => {
    const result = evaluateCancellationPolicy(longLeadBooking, {});
    expect(result.allowed).toBe(true);
    expect(result.refundAmount).toBe(500);
    expect(result.refundPercentage).toBe(100);
  });

  it('blocks cancellation for <24h lead with no policy', () => {
    const result = evaluateCancellationPolicy(shortLeadBooking, {});
    expect(result.allowed).toBe(false);
    expect(result.refundAmount).toBe(0);
    expect(result.refundPercentage).toBe(0);
  });

  it('never refunds an all-sales-final policy, even with a long lead', () => {
    const tour = {
      bookingAndTickets: {
        cancellationPolicy: { type: 'all_sales_final', label: 'No refunds', cancellationWindowHours: 0, refundPercentage: 0 },
      },
    };
    const result = evaluateCancellationPolicy(longLeadBooking, tour);
    expect(result.allowed).toBe(true);
    expect(result.refundAmount).toBe(0);
    expect(result.refundPercentage).toBe(0);
    expect(result.reason).toContain('all sales final');
  });

  it('does not treat cancellationWindowHours 0 as 24 for a standard policy', () => {
    const tour = {
      bookingAndTickets: {
        cancellationPolicy: { type: 'standard', cancellationWindowHours: 0, refundPercentage: 100 },
      },
    };
    const result = evaluateCancellationPolicy(shortLeadBooking, tour);
    expect(result.allowed).toBe(true);
    expect(result.refundAmount).toBe(500);
  });

  it('applies a partial refundPercentage when outside the window', () => {
    const tour = {
      bookingAndTickets: {
        cancellationPolicy: { type: 'standard', cancellationWindowHours: 24, refundPercentage: 50 },
      },
    };
    const result = evaluateCancellationPolicy(longLeadBooking, tour);
    expect(result.allowed).toBe(true);
    expect(result.refundAmount).toBe(250);
    expect(result.refundPercentage).toBe(50);
  });

  it('respects a custom cancellation window', () => {
    const tour = {
      bookingAndTickets: {
        cancellationPolicy: { type: 'standard', cancellationWindowHours: 48, refundPercentage: 100 },
      },
    };
    const short48Booking = { total: '500', selectedDate: new Date(Date.now() + 30 * 60 * 60 * 1000) };
    const result = evaluateCancellationPolicy(short48Booking, tour);
    expect(result.allowed).toBe(false);
    expect(result.refundAmount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getUpcomingBookings
// ---------------------------------------------------------------------------
describe('getUpcomingBookings', () => {
  it('returns upcoming bookings with related data', async () => {
    const mockBookings = [
      { id: 'b1', status: 'CONFIRMED', selectedDate: new Date(), customer: { id: 'c1', name: 'C', email: 'c@t.com', phone: '+1' }, tour: { title: 'Tour', supplier: { name: 'S', phone: '+2', email: 's@t.com' } } },
    ];
    prisma.booking.findMany.mockResolvedValue(mockBookings);

    const result = await getUpcomingBookings(24);
    expect(result).toEqual(mockBookings);
    expect(prisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'CONFIRMED' }),
      })
    );
  });

  it('returns empty array on error', async () => {
    prisma.booking.findMany.mockRejectedValue(new Error('DB error'));
    const result = await getUpcomingBookings(24);
    expect(result).toEqual([]);
  });
});
