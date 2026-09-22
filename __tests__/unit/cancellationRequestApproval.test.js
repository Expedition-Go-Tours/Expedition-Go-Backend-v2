/**
 * Supplier cancellation requests — admin-approval gate, unit tests.
 *
 * The critical property is that NOTHING touches the booking, money, or the
 * customer until an admin approves: every path is pinned here — creation,
 * dedupe, the atomic APPROVING claim, the supersede guard, reject, withdraw,
 * the 24h reminder (never auto-approve), and the notification matrix.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const mockPrisma = {
  cancellationRequest: {
    create: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    update: jest.fn(),
    updateMany: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
  },
  booking: {
    findUnique: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    update: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
  user: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
  tourDateOverride: {
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn().mockResolvedValue(null),
    upsert: jest.fn().mockResolvedValue({}),
    delete: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
  },
};

jest.mock('../../src/core/services/prismaClient', () => mockPrisma);

const mockNotifyAdmin = jest.fn().mockResolvedValue({});
jest.mock('../../src/core/services/adminNotificationService', () => ({ notifyAdmin: mockNotifyAdmin }));

const mockEnqueueNotification = jest.fn().mockResolvedValue({});
jest.mock('../../src/core/services/queue', () => ({
  enqueueNotification: mockEnqueueNotification,
  enqueueEmail: jest.fn().mockResolvedValue({}),
  enqueueEvent: jest.fn().mockResolvedValue({}),
}));

const mockSendEmail = jest.fn().mockResolvedValue({});
jest.mock('../../src/core/services/emailService', () => ({ sendEmail: mockSendEmail }));
jest.mock('../../src/core/services/auditLogger', () => ({ logActivity: jest.fn().mockResolvedValue() }));

const mockCancelBySupplier = jest.fn();
jest.mock('../../src/core/services/supplierCancellation', () => ({
  plannedRefund: jest.fn(() => ({ amount: 100, note: 'full refund (supplier cancellation)' })),
  cancelBySupplier: mockCancelBySupplier,
  matchPreview: jest.fn(),
}));

const service = require('../../src/core/services/cancellationRequestService');

const TOUR = { id: 't1', title: 'Cape Coast Castle Tour', slug: 'cape-coast', supplierId: 's1' };
const BOOKING = {
  id: 'b1',
  bookingNumber: 'BK-1',
  status: 'CONFIRMED',
  paymentStatus: 'SUCCEEDED',
  grossAmount: 100,
  currency: 'USD',
  travelDate: new Date('2026-12-01T09:00:00Z'),
  selectedTime: '09:00',
  customerId: 'c1',
  tour: TOUR,
  customer: { id: 'c1', name: 'Ama Traveller', email: 'ama@example.com' },
};
const VALID_PAYLOAD = {
  cancellationCode: 'GUIDE_UNAVAILABLE',
  agreedToTerms: true,
  explanation: 'Guide had an accident',
};
const REQ = { headers: {}, ip: '127.0.0.1' };

const serializedRow = (overrides = {}) => ({
  id: 'r1',
  status: 'PENDING_APPROVAL',
  bookingId: 'b1',
  supplierId: 's1',
  batchId: null,
  payload: VALID_PAYLOAD,
  preview: { refund: { amount: 100 }, fee: 25, countsTowardRate: true },
  stopSellingApplied: false,
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
  reminderCount: 0,
  createdAt: new Date('2026-10-01T10:00:00Z'),
  updatedAt: new Date('2026-10-01T10:00:00Z'),
  booking: BOOKING,
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SUPPLIER_CANCEL_REQUIRES_APPROVAL;
  delete process.env.ADMIN_OPS_EMAIL;
  delete process.env.SUPPORT_EMAIL;
  mockPrisma.cancellationRequest.findMany.mockResolvedValue([]);
  mockPrisma.cancellationRequest.count.mockResolvedValue(0);
  mockPrisma.booking.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.user.findUnique.mockResolvedValue({ id: 's1', name: 'Kofi Supplier', roles: [] });
});

describe('requiresApproval flag', () => {
  it('defaults OFF and only accepts truthy strings', () => {
    expect(service.requiresApproval()).toBe(false);
    for (const v of ['true', '1', 'YES', 'On']) {
      process.env.SUPPLIER_CANCEL_REQUIRES_APPROVAL = v;
      expect(service.requiresApproval()).toBe(true);
    }
    process.env.SUPPLIER_CANCEL_REQUIRES_APPROVAL = 'false';
    expect(service.requiresApproval()).toBe(false);
  });
});

describe('createCancellationRequest (nothing executes)', () => {
  it('parks the request and alerts admins without touching the booking', async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(BOOKING);
    mockPrisma.cancellationRequest.findFirst.mockResolvedValue(null);
    mockPrisma.cancellationRequest.create.mockResolvedValue({ id: 'r1', ...serializedRow() });
    mockPrisma.cancellationRequest.findUnique.mockResolvedValueOnce(serializedRow());
    process.env.ADMIN_OPS_EMAIL = 'ops@example.com';

    const result = await service.createCancellationRequest({
      booking: BOOKING,
      payload: VALID_PAYLOAD,
      supplierId: 's1',
      req: REQ,
    });

    // No booking write, no Stripe, no cancelBySupplier.
    expect(mockPrisma.booking.update).not.toHaveBeenCalled();
    expect(mockCancelBySupplier).not.toHaveBeenCalled();

    expect(mockPrisma.cancellationRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          bookingId: 'b1',
          supplierId: 's1',
          payload: expect.objectContaining({ cancellationCode: 'GUIDE_UNAVAILABLE' }),
          preview: expect.objectContaining({ fee: 25, countsTowardRate: true }),
        }),
      }),
    );

    const alert = mockNotifyAdmin.mock.calls.find((c) => c[0].type === 'SUPPLIER_CANCELLATION_REQUEST');
    expect(alert).toBeTruthy();
    expect(alert[0].data.requestId).toBe('r1');

    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: ['ops@example.com'], template: 'admin-cancellation-request' }),
    );

    expect(result.request.id).toBe('r1');
    expect(result.booking).toBe(BOOKING);
  });

  it('rejects an unstructured payload before anything is written', async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(BOOKING);
    await expect(
      service.createCancellationRequest({ booking: BOOKING, payload: { status: 'CANCELLED' }, supplierId: 's1', req: REQ }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(mockPrisma.cancellationRequest.create).not.toHaveBeenCalled();
  });

  it('refuses a booking that is no longer cancellable', async () => {
    mockPrisma.booking.findUnique.mockResolvedValue({ ...BOOKING, status: 'COMPLETED' });
    await expect(
      service.createCancellationRequest({ booking: BOOKING, payload: VALID_PAYLOAD, supplierId: 's1', req: REQ }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses a second request while one is pending', async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(BOOKING);
    mockPrisma.cancellationRequest.findFirst.mockResolvedValue({ id: 'r-existing' });
    await expect(
      service.createCancellationRequest({ booking: BOOKING, payload: VALID_PAYLOAD, supplierId: 's1', req: REQ }),
    ).rejects.toThrow(/already awaiting approval/);
  });

  it('falls back to SUPPORT_EMAIL when ADMIN_OPS_EMAIL is unset', async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(BOOKING);
    mockPrisma.cancellationRequest.findFirst.mockResolvedValue(null);
    mockPrisma.cancellationRequest.create.mockResolvedValue({ id: 'r1', ...serializedRow() });
    mockPrisma.cancellationRequest.findUnique.mockResolvedValueOnce(serializedRow());
    process.env.SUPPORT_EMAIL = 'support@example.com';

    try {
      await service.createCancellationRequest({ booking: BOOKING, payload: VALID_PAYLOAD, supplierId: 's1', req: REQ });
      expect(mockSendEmail).toHaveBeenCalledWith(
        expect.objectContaining({ to: ['support@example.com'], template: 'admin-cancellation-request' }),
      );
    } finally {
      delete process.env.SUPPORT_EMAIL;
    }
  });

  it('skips the ops email (with a warning) when no mailbox is configured', async () => {
    delete process.env.SUPPORT_EMAIL;
    mockPrisma.booking.findUnique.mockResolvedValue(BOOKING);
    mockPrisma.cancellationRequest.findFirst.mockResolvedValue(null);
    mockPrisma.cancellationRequest.create.mockResolvedValue({ id: 'r1', ...serializedRow() });
    mockPrisma.cancellationRequest.findUnique.mockResolvedValueOnce(serializedRow());
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await service.createCancellationRequest({ booking: BOOKING, payload: VALID_PAYLOAD, supplierId: 's1', req: REQ });

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no ops mailbox'), 'r1');
    warn.mockRestore();
  });
});

describe('approveCancellationRequest (atomic claim + execute)', () => {
  const claimRequest = (bookingOverrides = {}) => {
    mockPrisma.cancellationRequest.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.cancellationRequest.findUnique.mockResolvedValue({
      id: 'r1',
      status: 'APPROVING',
      supplierId: 's1',
      payload: { ...VALID_PAYLOAD, supplierNotes: 'Called ahead' },
      preview: { refund: { amount: 100 }, fee: 25 },
      booking: { ...BOOKING, ...bookingOverrides, tour: TOUR },
    });
  };

  it('claims, executes with the stored payload, and records the decision', async () => {
    claimRequest();
    mockCancelBySupplier.mockResolvedValue({
      booking: { ...BOOKING, status: 'CANCELLED' },
      refundAmount: 100,
      refundStatus: 'PENDING',
      refundExecuted: false,
      fee: 25,
      countsTowardRate: true,
      choiceDeadline: new Date('2026-10-03T10:00:00Z'),
    });
    mockPrisma.booking.update.mockResolvedValue({ ...BOOKING, status: 'CANCELLED', supplierNotes: 'Called ahead' });
    mockPrisma.cancellationRequest.update.mockResolvedValue({ id: 'r1', status: 'APPROVED' });
    mockPrisma.cancellationRequest.findUnique.mockResolvedValueOnce({
      id: 'r1', status: 'APPROVING', supplierId: 's1', payload: { ...VALID_PAYLOAD, supplierNotes: 'Called ahead' },
      preview: {}, booking: { ...BOOKING, tour: TOUR },
    }).mockResolvedValue(serializedRow({ status: 'APPROVED' }));

    const result = await service.approveCancellationRequest({
      requestId: 'r1',
      adminUser: { id: 'admin1', name: 'Ada Admin' },
      req: REQ,
      note: 'Verified with the guide',
    });

    // The claim is what makes double-approval impossible.
    expect(mockPrisma.cancellationRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1', status: 'PENDING_APPROVAL' },
      data: { status: 'APPROVING' },
    });
    expect(mockCancelBySupplier).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ cancellationCode: 'GUIDE_UNAVAILABLE' }),
        supplierId: 'admin1',
        skipValidation: true,
      }),
    );
    expect(mockPrisma.cancellationRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'r1' },
        data: expect.objectContaining({ status: 'APPROVED', decidedBy: 'admin1', decisionNote: 'Verified with the guide' }),
      }),
    );
    expect(result.booking.status).toBe('CANCELLED');
    expect(result.cancellation).toMatchObject({ refundAmount: 100, fee: 25, countsTowardRate: true });
  });

  it('notifies admins + the supplier (in-app AND pref-gated email)', async () => {
    claimRequest();
    mockCancelBySupplier.mockResolvedValue({
      booking: { ...BOOKING, status: 'CANCELLED' },
      refundAmount: 100, refundStatus: 'PENDING', refundExecuted: false, fee: 25, countsTowardRate: false, choiceDeadline: null,
    });
    mockPrisma.cancellationRequest.update.mockResolvedValue({ id: 'r1', status: 'APPROVED' });
    mockPrisma.cancellationRequest.findUnique.mockResolvedValue(serializedRow({ status: 'APPROVED' }));

    await service.approveCancellationRequest({
      requestId: 'r1', adminUser: { id: 'admin1', name: 'Ada Admin' }, req: REQ,
    });

    expect(mockNotifyAdmin.mock.calls.some((c) => c[0].type === 'SUPPLIER_CANCELLATION_DECIDED')).toBe(true);

    const supplierCall = mockEnqueueNotification.mock.calls.find(
      (c) => c[0].type === 'CANCELLATION_REQUEST_APPROVED',
    );
    expect(supplierCall).toBeTruthy();
    expect(supplierCall[0]).toMatchObject({
      userId: 's1',
      sendEmail: true,
      emailTemplate: 'supplier-cancellation-decision',
    });
    expect(supplierCall[0].data.approved).toBe(true);
  });

  it('409s when the claim is lost (already decided / in flight)', async () => {
    mockPrisma.cancellationRequest.updateMany.mockResolvedValueOnce({ count: 0 });
    mockPrisma.cancellationRequest.findUnique.mockResolvedValue({ status: 'APPROVED' });

    await expect(
      service.approveCancellationRequest({ requestId: 'r1', adminUser: { id: 'admin1', name: 'A' }, req: REQ }),
    ).rejects.toThrow(/already approved/);
    expect(mockCancelBySupplier).not.toHaveBeenCalled();
  });

  it('supersedes (instead of executing) when the booking moved on', async () => {
    mockPrisma.cancellationRequest.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 1 });
    mockPrisma.cancellationRequest.findUnique.mockResolvedValue({
      id: 'r1', status: 'APPROVING', supplierId: 's1', payload: VALID_PAYLOAD, preview: {},
      booking: { ...BOOKING, status: 'COMPLETED', tour: TOUR },
    });

    await expect(
      service.approveCancellationRequest({ requestId: 'r1', adminUser: { id: 'admin1', name: 'A' }, req: REQ }),
    ).rejects.toThrow(/superseded/);
    expect(mockCancelBySupplier).not.toHaveBeenCalled();
    expect(mockPrisma.cancellationRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SUPERSEDED' }) }),
    );
  });

  it('releases the claim when the executor fails so the request can be retried', async () => {
    claimRequest();
    mockCancelBySupplier.mockRejectedValue(new Error('Stripe down'));

    await expect(
      service.approveCancellationRequest({ requestId: 'r1', adminUser: { id: 'admin1', name: 'A' }, req: REQ }),
    ).rejects.toThrow('Stripe down');

    expect(mockPrisma.cancellationRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1', status: 'APPROVING' },
      data: { status: 'PENDING_APPROVAL' },
    });
  });
});

describe('rejectCancellationRequest', () => {
  it('requires a reason', async () => {
    await expect(
      service.rejectCancellationRequest({ requestId: 'r1', adminUser: { id: 'a1' }, req: REQ, note: '  ' }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(mockPrisma.cancellationRequest.updateMany).not.toHaveBeenCalled();
  });

  it('rejects an open request and tells the supplier why', async () => {
    mockPrisma.cancellationRequest.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.cancellationRequest.update.mockResolvedValue({ id: 'r1', status: 'REJECTED' });
    mockPrisma.cancellationRequest.findUnique.mockResolvedValue(serializedRow({ status: 'REJECTED' }));

    const result = await service.rejectCancellationRequest({
      requestId: 'r1', adminUser: { id: 'a1', name: 'Ada' }, req: REQ, note: 'Experience is still runnable',
    });

    expect(mockPrisma.booking.update).not.toHaveBeenCalled(); // booking untouched
    const supplierCall = mockEnqueueNotification.mock.calls.find(
      (c) => c[0].type === 'CANCELLATION_REQUEST_REJECTED',
    );
    expect(supplierCall[0].data.approved).toBe(false);
    expect(supplierCall[0].sendEmail).toBe(true);
    expect(result.request.status).toBe('REJECTED');
  });
});

describe('withdrawCancellationRequest', () => {
  it('is scoped to the supplier and only to open requests', async () => {
    mockPrisma.cancellationRequest.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.cancellationRequest.update.mockResolvedValue({ id: 'r1', status: 'WITHDRAWN' });
    mockPrisma.cancellationRequest.findUnique.mockResolvedValue(serializedRow({ status: 'WITHDRAWN' }));

    await service.withdrawCancellationRequest({ requestId: 'r1', supplierId: 's1', actorId: 'u9', req: REQ });

    expect(mockPrisma.cancellationRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1', status: { in: ['PENDING_APPROVAL', 'APPROVING'] }, supplierId: 's1' },
      data: { status: 'WITHDRAWN' },
    });
  });

  it('404s for someone else’s request', async () => {
    mockPrisma.cancellationRequest.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      service.withdrawCancellationRequest({ requestId: 'r1', supplierId: 'other', req: REQ }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('supersedePendingRequests', () => {
  it('accepts ids in bulk and reverts marker-owned stop-selling rows', async () => {
    mockPrisma.cancellationRequest.updateMany.mockResolvedValue({ count: 2 });
    mockPrisma.cancellationRequest.findMany.mockResolvedValue([
      {
        id: 'r1',
        stopSellingApplied: true,
        preview: {
          stopSell: {
            tourId: 't1',
            marker: 'Blocked by cancellation request cb_x',
            blocked: [{ date: '2026-12-01' }],
            snapshot: [{ date: '2026-12-01', prevStatus: null, prevNotes: null }],
          },
        },
      },
    ]);
    mockPrisma.tourDateOverride.findUnique.mockResolvedValue({
      date: new Date('2026-12-01'), status: 'BLOCKED', notes: 'Blocked by cancellation request cb_x',
    });

    const count = await service.supersedePendingRequests(['b1', 'b2'], 'Booking completed');

    expect(count).toBe(2);
    expect(mockPrisma.cancellationRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bookingId: { in: ['b1', 'b2'] }, status: { in: ['PENDING_APPROVAL', 'APPROVING'] } },
      }),
    );
    expect(mockPrisma.tourDateOverride.delete).toHaveBeenCalled();
  });

  it('never touches dates someone else changed', async () => {
    mockPrisma.cancellationRequest.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.cancellationRequest.findMany.mockResolvedValue([
      {
        id: 'r1',
        stopSellingApplied: true,
        preview: {
          stopSell: {
            tourId: 't1',
            marker: 'Blocked by cancellation request cb_x',
            blocked: [{ date: '2026-12-01' }],
            snapshot: [],
          },
        },
      },
    ]);
    mockPrisma.tourDateOverride.findUnique.mockResolvedValue({
      date: new Date('2026-12-01'), status: 'BLOCKED', notes: 'Blocked manually',
    });

    await service.supersedePendingRequests('b1', 'reason');
    expect(mockPrisma.tourDateOverride.delete).not.toHaveBeenCalled();
    expect(mockPrisma.tourDateOverride.update).not.toHaveBeenCalled();
  });
});

describe('remindPendingCancellationRequests (escalate, never approve)', () => {
  it('reminds requests older than 24h and bumps the counter', async () => {
    mockPrisma.cancellationRequest.findMany.mockResolvedValue([
      {
        id: 'r1',
        createdAt: new Date(Date.now() - 26 * 60 * 60 * 1000),
        reminderCount: 0,
        supplierId: 's1',
        booking: { id: 'b1', bookingNumber: 'BK-1', tour: { id: 't1', title: 'Cape Coast Castle Tour' } },
      },
    ]);

    const result = await service.remindPendingCancellationRequests();

    expect(result.reminded).toBe(1);
    const alert = mockNotifyAdmin.mock.calls.find(
      (c) => c[0].type === 'SUPPLIER_CANCELLATION_REQUEST' && c[0].data.reminder === true,
    );
    expect(alert).toBeTruthy();
    expect(mockPrisma.cancellationRequest.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { reminderSentAt: expect.any(Date), reminderCount: { increment: 1 } },
    });
    // The request stays PENDING_APPROVAL — the sweep never decides.
    expect(mockPrisma.cancellationRequest.updateMany).not.toHaveBeenCalled();
  });

  it('does nothing when nothing is due', async () => {
    mockPrisma.cancellationRequest.findMany.mockResolvedValue([]);
    expect((await service.remindPendingCancellationRequests()).reminded).toBe(0);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });
});

describe('pendingRequestsForBookingIds (supplier list chips)', () => {
  it('maps open requests by booking id', async () => {
    mockPrisma.cancellationRequest.findMany.mockResolvedValue([
      { id: 'r1', status: 'PENDING_APPROVAL', createdAt: new Date('2026-10-01T10:00:00Z'), bookingId: 'b1' },
    ]);
    const map = await service.pendingRequestsForBookingIds(['b1', 'b2']);
    expect(map.get('b1')).toMatchObject({ id: 'r1', status: 'PENDING_APPROVAL' });
    expect(map.get('b2')).toBeUndefined();
  });

  it('returns an empty map without querying when there are no ids', async () => {
    const map = await service.pendingRequestsForBookingIds([]);
    expect(map.size).toBe(0);
  });
});
