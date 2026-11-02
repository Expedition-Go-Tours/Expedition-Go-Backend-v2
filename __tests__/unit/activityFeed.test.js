jest.mock('../../src/core/services/prismaClient', () => ({
  booking: { findMany: jest.fn() },
  review: { findMany: jest.fn() },
  wishlistItem: { findMany: jest.fn() },
  supplierRefundRequest: { findMany: jest.fn() },
  payoutRequest: { findMany: jest.fn() },
  event: { findMany: jest.fn() },
  auditLog: { findMany: jest.fn() },
  user: { findMany: jest.fn() },
  tour: { findMany: jest.fn() },
}));

jest.mock('../../src/core/domain/adminController', () => ({
  buildAuditMessage: (action) => action.replace(/\./g, ' '),
}));

const prisma = require('../../src/core/services/prismaClient');
const { getActivityFeed, _private } = require('../../src/core/services/activityFeed');

const BOOKING = {
  id: 'b1',
  bookingNumber: 'TRG-97679268-2026-78',
  status: 'CONFIRMED',
  paymentStatus: 'SUCCEEDED',
  grossAmount: 90,
  refundAmount: null,
  currency: 'USD',
  createdAt: new Date('2026-11-02T10:00:00.000Z'),
  paidAt: null,
  cancelledAt: null,
  refundedAt: null,
  leadTravelerName: null,
  customer: { id: 'c1', name: 'Ama Mensah', photoURL: null, roles: ['customer'] },
  tour: {
    id: 't1',
    title: 'Cape Coast Castle',
    slug: 'cape-coast-castle',
    supplier: { id: 's1', name: 'Akosua Tours' },
  },
};

function resetMocks() {
  jest.clearAllMocks();
  for (const model of [
    prisma.booking,
    prisma.review,
    prisma.wishlistItem,
    prisma.supplierRefundRequest,
    prisma.payoutRequest,
    prisma.event,
    prisma.auditLog,
    prisma.user,
    prisma.tour,
  ]) {
    for (const fn of Object.values(model)) {
      fn.mockResolvedValue([]);
    }
  }
}

describe('activityFeed', () => {
  beforeEach(resetMocks);

  it('resolves today, yesterday and rolling week windows', () => {
    const today = _private.resolveWindow('today');
    const yesterday = _private.resolveWindow('yesterday');
    const week = _private.resolveWindow('week');

    expect(today.start.getTime()).toBeLessThanOrEqual(today.end.getTime());
    expect(yesterday.end.getTime()).toBe(today.start.getTime());
    expect(yesterday.start.getTime()).toBeLessThan(yesterday.end.getTime());
    expect(week.start.getTime()).toBeLessThan(yesterday.start.getTime());
  });

  it('round-trips an opaque cursor', () => {
    const item = { id: 'b1', occurredAt: new Date('2026-11-02T10:00:00.000Z') };
    const encoded = _private.encodeCursor(item);
    const decoded = _private.decodeCursor(encoded);
    expect(decoded.id).toBe('b1');
    expect(decoded.date.toISOString()).toBe(item.occurredAt.toISOString());
    expect(_private.decodeCursor('not-a-cursor')).toBeNull();
    expect(_private.cursorIdFor({ id: 'booking:b1:created' })).toBe('b1');
    expect(_private.cursorIdFor({ id: 'audit:a1' })).toBe('a1');
  });

  it('composes a rich created-booking row', () => {
    const row = _private.bookingRow(BOOKING, 'booking.created', BOOKING.createdAt);
    expect(row.summary).toBe('Ama Mensah booked Cape Coast Castle');
    expect(row.detail).toContain('TRG-97679268-2026-78');
    expect(row.detail).toContain('$90.00');
    expect(row.href).toBe('/admin/bookings?bookingId=b1');
    expect(row.type).toBe('booking');
  });

  it('emits one row per refund lifecycle step', () => {
    const rows = _private.refundRows({
      id: 'r1',
      requestNumber: 'SR-1',
      status: 'COMPLETED',
      createdAt: new Date('2026-11-02T09:00:00.000Z'),
      decidedAt: new Date('2026-11-02T10:00:00.000Z'),
      executedAt: new Date('2026-11-02T11:00:00.000Z'),
      refundedAmount: 20,
      preview: { requested: 20 },
      supplier: { id: 's1', name: 'Akosua Tours', photoURL: null, roles: ['supplier'] },
      booking: {
        id: 'b1',
        bookingNumber: 'TRG-1',
        currency: 'USD',
        grossAmount: 90,
        tour: { id: 't1', title: 'Cape Coast Castle', slug: 'cape-coast-castle' },
      },
    });

    expect(rows.map((row) => row.action)).toEqual([
      'refund.requested',
      'refund.approved',
      'refund.completed',
    ]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(3);
  });

  it('describes a search event with its query and result count', () => {
    const composed = _private.eventSummary(
      {
        name: 'search.executed',
        properties: { query: 'cape coast', resultCount: 3 },
      },
      { id: 'c1', name: 'Ama Mensah', role: 'customer' },
      null,
    );

    expect(composed.summary).toBe('Ama Mensah searched for “cape coast”');
    expect(composed.detail).toBe('3 results');
    expect(composed.type).toBe('customer');
  });

  it('merges, sorts and paginates the feed', async () => {
    const event = {
      id: 'e1',
      name: 'ghana.checkout_started',
      userId: 'c1',
      resource: 'Tour',
      resourceId: 't1',
      properties: { total: 90, currency: 'USD' },
      createdAt: new Date('2026-11-02T11:00:00.000Z'),
    };

    prisma.booking.findMany
      .mockResolvedValueOnce([BOOKING])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    prisma.event.findMany.mockResolvedValue([event]);
    prisma.user.findMany.mockImplementation(({ where }) => {
      if (where && where.roles) return Promise.resolve([{ id: 'staff-1' }]);
      if (where && where.id && where.id.in && where.id.in.includes('c1')) {
        return Promise.resolve([
          { id: 'c1', name: 'Ama Mensah', photoURL: null, roles: ['customer'] },
        ]);
      }
      return Promise.resolve([]);
    });
    prisma.tour.findMany.mockResolvedValue([
      { id: 't1', title: 'Cape Coast Castle', slug: 'cape-coast-castle' },
    ]);

    const page = await getActivityFeed({ window: 'week', limit: 1 });

    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBeTruthy();
    expect(page.items[0].action).toBe('checkout.started');
    expect(page.items[0].summary).toBe('Ama Mensah started checkout for Cape Coast Castle');
  });

  it('scopes bookings to the Ghana brand', async () => {
    await getActivityFeed({ window: 'today', type: 'bookings' });

    const firstWhere = prisma.booking.findMany.mock.calls[0][0].where;
    const serialized = JSON.stringify(firstWhere);
    expect(serialized).toContain('GHANA');
    expect(serialized).toContain('ghana');
    expect(serialized).toContain('isSimulated');
  });

  it('does not query unrelated sources for a narrow type filter', async () => {
    await getActivityFeed({ window: 'today', type: 'reviews' });

    expect(prisma.booking.findMany).not.toHaveBeenCalled();
    expect(prisma.wishlistItem.findMany).not.toHaveBeenCalled();
    expect(prisma.supplierRefundRequest.findMany).not.toHaveBeenCalled();
    expect(prisma.payoutRequest.findMany).not.toHaveBeenCalled();
    expect(prisma.review.findMany).toHaveBeenCalled();
  });

  it('excludes auth and api-error noise by construction', async () => {
    await getActivityFeed({ window: 'today', type: 'system' });

    const where = JSON.stringify(prisma.auditLog.findMany.mock.calls[0][0].where);
    expect(where).not.toContain('auth.login');
    expect(where).not.toContain('api.error');
    expect(where).toContain('tour.created');
  });
});
