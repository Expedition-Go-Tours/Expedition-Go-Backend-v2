/**
 * Cancellation Requests — HTTP-layer contract.
 *
 * The approval gate's whole point is who may do what:
 *   - queue visibility needs `bookings.view`
 *   - deciding needs `cancellations.approve`
 *   - suppliers only ever see/withdraw their OWN requests
 * and the response shapes the admin + supplier UIs will bind to.
 */

const request = require('supertest');
const { signAccessToken } = require('../../config/jwt');

jest.mock('../../src/core/services/prismaClient', () => ({
  user: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
  adminRole: { findUnique: jest.fn() },
  adminPermission: { findMany: jest.fn().mockResolvedValue([]) },
  supplierProfile: { findFirst: jest.fn(), findUnique: jest.fn() },
  teamMember: { findFirst: jest.fn().mockResolvedValue(null) },
  cancellationRequest: {
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
    findUnique: jest.fn().mockResolvedValue(null),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    count: jest.fn().mockResolvedValue(0),
  },
  booking: {
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
    findUnique: jest.fn().mockResolvedValue(null),
    update: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    count: jest.fn().mockResolvedValue(0),
    groupBy: jest.fn().mockResolvedValue([]),
    aggregate: jest.fn().mockResolvedValue({ _sum: {} }),
  },
  tourDateOverride: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn(), delete: jest.fn(), update: jest.fn() },
  adminNotification: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
  notification: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
  auditLog: { create: jest.fn().mockResolvedValue({}) },
  payout: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
  $transaction: jest.fn(async (cb) => (typeof cb === 'function' ? cb(require('../../src/core/services/prismaClient')) : cb)),
}));

jest.mock('../../src/core/services/cacheHelper', () => ({
  getOrSet: jest.fn((key, fn) => fn()),
  invalidateKey: jest.fn(() => Promise.resolve()),
  invalidateKeys: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/emailService', () => ({ sendEmail: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/core/services/queue', () => ({
  enqueueEvent: jest.fn(() => Promise.resolve()),
  enqueueEmail: jest.fn(() => Promise.resolve()),
  enqueueNotification: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/adminNotificationService', () => ({
  notifyAdmin: jest.fn(() => Promise.resolve()),
  notifyDiscord: jest.fn(),
}));
jest.mock('../../src/core/services/auditLogger', () => ({ logActivity: jest.fn(() => Promise.resolve()) }));

const app = require('../../app');
const prisma = require('../../src/core/services/prismaClient');

const ADMIN = { id: 'admin-1', name: 'Ops Admin', email: 'ops@test.com', roles: ['admin'], active: true, adminRoleId: 'role-ops', photoURL: '', notificationPreferences: null };
const APPROVER = { ...ADMIN, id: 'admin-2', email: 'approver@test.com', adminRoleId: 'role-approver' };
const SUPPLIER = { id: 'supplier-1', name: 'Kofi Supplier', email: 'kofi@test.com', roles: ['supplier'], active: true, photoURL: '', notificationPreferences: null };

const USERS = { 'admin-1': ADMIN, 'admin-2': APPROVER, 'supplier-1': SUPPLIER };
const adminToken = signAccessToken({ userId: 'admin-1' });
const approverToken = signAccessToken({ userId: 'admin-2' });
const supplierToken = signAccessToken({ userId: 'supplier-1' });

const setAdminPermissions = (keys) => {
  prisma.adminRole.findUnique.mockResolvedValue({
    id: 'role-x',
    name: 'test-role',
    permissions: keys.map((key) => ({ permission: { key } })),
  });
};

const REQUEST_ROW = {
  id: 'r1',
  status: 'PENDING_APPROVAL',
  bookingId: 'b1',
  supplierId: 'supplier-1',
  batchId: null,
  payload: { cancellationCode: 'GUIDE_UNAVAILABLE', cancellationCategory: 'OPERATIONAL' },
  preview: { refund: { amount: 100 }, fee: 25, countsTowardRate: true },
  stopSellingApplied: false,
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
  reminderCount: 0,
  createdAt: new Date('2026-10-01T10:00:00Z'),
  updatedAt: new Date('2026-10-01T10:00:00Z'),
  booking: {
    id: 'b1', bookingNumber: 'BK-1', status: 'CONFIRMED', paymentStatus: 'SUCCEEDED',
    refundStatus: null, refundAmount: null, grossAmount: 100, currency: 'USD',
    travelDate: new Date('2026-12-01T09:00:00Z'), selectedTime: '09:00',
    cancellationCode: null, cancellationCategory: null, cancellationOrigin: null,
    countsTowardRate: null, cancellationFee: null, cancellationReason: null,
    cancelledAt: null, cancellationChoiceDeadline: null, customerChoice: null,
    customer: { id: 'c1', name: 'Ama', email: 'ama@test.com' },
    tour: { id: 't1', title: 'Cape Coast Castle Tour', supplierId: 'supplier-1', supplier: { id: 'supplier-1', name: 'Kofi Supplier' } },
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SUPPLIER_CANCEL_REQUIRES_APPROVAL;
  delete process.env.ADMIN_OPS_EMAIL;
  prisma.user.findUnique.mockImplementation(async ({ where }) => USERS[where.id] || null);
  prisma.user.findMany.mockImplementation(async ({ where }) => {
    const ids = (where && where.id && where.id.in) || [];
    return ids.map((id) => ({ id, name: 'Kofi Supplier', email: 'kofi@test.com', roles: ['supplier'] }));
  });
  prisma.cancellationRequest.findMany.mockResolvedValue([]);
  prisma.cancellationRequest.count.mockResolvedValue(0);
  prisma.cancellationRequest.findFirst.mockResolvedValue(null);
  prisma.cancellationRequest.findUnique.mockResolvedValue(null);
  prisma.cancellationRequest.updateMany.mockResolvedValue({ count: 0 });
  prisma.supplierProfile.findFirst.mockResolvedValue({ id: 'profile-1' });
  prisma.supplierProfile.findUnique.mockResolvedValue({ id: 'profile-1', userId: 'supplier-1', status: 'ACTIVE' });
  setAdminPermissions(['dashboard.*', 'bookings.view', 'cancellations.approve']);
});

// ── Admin queue: authz ───────────────────────────────────────────────────
describe('GET /api/admin/cancellation-requests', () => {
  it('401s without a token', async () => {
    await request(app).get('/api/admin/cancellation-requests').expect(401);
  });

  it('403s for a supplier (admin-only surface)', async () => {
    await request(app)
      .get('/api/admin/cancellation-requests')
      .set('Authorization', `Bearer ${supplierToken}`)
      .expect(403);
  });

  it('403s for an admin without bookings.view', async () => {
    setAdminPermissions(['reviews.view']);
    await request(app)
      .get('/api/admin/cancellation-requests')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(403);
  });

  it('returns the queue with pendingCount + pagination', async () => {
    prisma.cancellationRequest.findMany.mockResolvedValue([REQUEST_ROW]);
    prisma.cancellationRequest.count.mockImplementation(async ({ where }) =>
      where && where.status === 'PENDING_APPROVAL' ? 1 : 1);

    const res = await request(app)
      .get('/api/admin/cancellation-requests?status=PENDING_APPROVAL')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.status).toBe('success');
    expect(res.body.data.requests).toHaveLength(1);
    expect(res.body.data.requests[0]).toMatchObject({
      id: 'r1',
      status: 'PENDING_APPROVAL',
      supplier: { id: 'supplier-1' },
      booking: { bookingNumber: 'BK-1' },
      tour: { title: 'Cape Coast Castle Tour' },
    });
    expect(res.body.data.pendingCount).toBe(1);
    expect(res.body.data.pagination).toMatchObject({ currentPage: 1, totalCount: 1 });
  });
});

// ── Decisions: the permission that actually matters ──────────────────────
describe('decision endpoints', () => {
  it('403s approve for an admin who can only view bookings', async () => {
    setAdminPermissions(['bookings.view']);
    await request(app)
      .post('/api/admin/cancellation-requests/r1/approve')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(403);
  });

  it('404s approving an unknown request', async () => {
    prisma.cancellationRequest.updateMany.mockResolvedValue({ count: 0 });
    prisma.cancellationRequest.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/admin/cancellation-requests/nope/approve')
      .set('Authorization', `Bearer ${approverToken}`)
      .send({})
      .expect(404);
    expect(res.body.message).toMatch(/not found/i);
  });

  it('400s rejecting without a reason (and writes nothing)', async () => {
    const res = await request(app)
      .post('/api/admin/cancellation-requests/r1/reject')
      .set('Authorization', `Bearer ${approverToken}`)
      .send({})
      .expect(400);
    expect(res.body.message).toMatch(/reason is required/i);
    expect(prisma.cancellationRequest.updateMany).not.toHaveBeenCalled();
  });

  it('400s a batch-approve with no ids', async () => {
    await request(app)
      .post('/api/admin/cancellation-requests/batch-approve')
      .set('Authorization', `Bearer ${approverToken}`)
      .send({ ids: [] })
      .expect(400);
  });

  it('403s batch-approve without cancellations.approve', async () => {
    setAdminPermissions(['bookings.view']);
    await request(app)
      .post('/api/admin/cancellation-requests/batch-approve')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ids: ['r1'] })
      .expect(403);
  });
});

// ── Supplier side: own requests only ─────────────────────────────────────
describe('supplier cancellation-request routes', () => {
  it('401s without a token', async () => {
    await request(app).get('/api/bookings/supplier/cancellation-requests').expect(401);
  });

  it('lists the supplier’s own requests', async () => {
    prisma.cancellationRequest.findMany.mockResolvedValue([REQUEST_ROW]);
    prisma.cancellationRequest.count.mockResolvedValue(1);

    const res = await request(app)
      .get('/api/bookings/supplier/cancellation-requests')
      .set('Authorization', `Bearer ${supplierToken}`)
      .expect(200);

    expect(res.body.data.requests).toHaveLength(1);
    expect(prisma.cancellationRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ supplierId: 'supplier-1' }) }),
    );
  });

  it('404s withdrawing someone else’s request', async () => {
    prisma.cancellationRequest.updateMany.mockResolvedValue({ count: 0 });

    await request(app)
      .post('/api/bookings/supplier/cancellation-requests/r1/withdraw')
      .set('Authorization', `Bearer ${supplierToken}`)
      .send({})
      .expect(404);
  });

  it('withdraws an open request (scoped to the supplier)', async () => {
    prisma.cancellationRequest.updateMany.mockResolvedValue({ count: 1 });
    prisma.cancellationRequest.update.mockResolvedValue({ id: 'r1', status: 'WITHDRAWN' });
    prisma.cancellationRequest.findUnique.mockResolvedValue({ ...REQUEST_ROW, status: 'WITHDRAWN' });

    const res = await request(app)
      .post('/api/bookings/supplier/cancellation-requests/r1/withdraw')
      .set('Authorization', `Bearer ${supplierToken}`)
      .send({})
      .expect(200);

    expect(res.body.data.request.status).toBe('WITHDRAWN');
    expect(prisma.cancellationRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'r1', supplierId: 'supplier-1' }),
      }),
    );
  });
});
