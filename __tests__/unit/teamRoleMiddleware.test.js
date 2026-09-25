/**
 * Team role middleware — membership lookups and permission checks.
 *
 * Uses a STATEFUL cache (unlike the API tests, which stub getOrSet to always
 * call through). That is deliberate: `resolveSupplier` and the permission
 * middlewares share one membership cache key, and caching a narrower select
 * there once made a member's permissions depend on which middleware ran first
 * on a route.
 */
const mockCacheStore = new Map();

jest.mock('../../src/core/services/cacheHelper', () => ({
  getOrSet: jest.fn(async (key, fn) => {
    if (mockCacheStore.has(key)) return mockCacheStore.get(key);
    const value = await fn();
    mockCacheStore.set(key, value);
    return value;
  }),
  invalidateKey: jest.fn(async (key) => { mockCacheStore.delete(key); }),
  invalidateKeys: jest.fn(async () => { mockCacheStore.clear(); }),
}));

jest.mock('../../src/core/services/prismaClient', () => ({
  supplierProfile: { findFirst: jest.fn() },
  teamMember: { findFirst: jest.fn() },
}));

const prisma = require('../../src/core/services/prismaClient');
const {
  resolveSupplier,
  requireTeamRole,
  requireTeamPermission,
  resolveSupplierIdForUser,
} = require('../../middleware/teamRoleMiddleware');

const MEMBER = {
  id: 'user-1',
  email: 'member@test.com',
  roles: ['customer', 'supplier', 'ghana'],
};

/** Project a row the way Prisma does when `select` is given. */
function project(row, select) {
  if (!select) return row;
  return Object.fromEntries(Object.keys(select).filter((key) => key in row).map((key) => [key, row[key]]));
}

/** Configure the membership lookup for this test. */
function mockMembership(row) {
  prisma.teamMember.findFirst.mockImplementation(({ select }) => Promise.resolve(
    row ? project({ ...row, email: MEMBER.email }, select) : null,
  ));
}

const run = async (middleware, req) => {
  let captured;
  await middleware(req, {}, (error) => { captured = error; });
  return captured;
};

const request = () => ({ user: { ...MEMBER } });

beforeEach(() => {
  mockCacheStore.clear();
  jest.clearAllMocks();
  // The member has no supplier profile of their own.
  prisma.supplierProfile.findFirst.mockResolvedValue(null);
});

describe('resolveSupplierIdForUser', () => {
  beforeEach(() => {
    prisma.supplierProfile.findFirst.mockResolvedValue(null);
    prisma.teamMember.findFirst.mockResolvedValue(null);
  });

  it('returns the owner id for a supplier that owns its profile', async () => {
    prisma.supplierProfile.findFirst.mockResolvedValue({ id: 'profile-1' });

    await expect(resolveSupplierIdForUser({ id: 'owner-1', roles: ['supplier'], email: 'owner@test.com' }))
      .resolves.toBe('owner-1');
  });

  it("returns the OWNER's id for an accepted team member", async () => {
    mockMembership({ roles: ['support'], role: 'support', supplierId: 'owner-1' });

    await expect(resolveSupplierIdForUser({ ...MEMBER })).resolves.toBe('owner-1');
  });

  it('returns null for a customer with no membership (chat must not 403 them)', async () => {
    await expect(resolveSupplierIdForUser({ id: 'cust-1', roles: ['customer'], email: 'c@test.com' }))
      .resolves.toBeNull();
  });

  it('returns null for an admin who is not linked to a supplier profile', async () => {
    await expect(resolveSupplierIdForUser({ id: 'admin-1', roles: ['admin'], email: 'a@test.com' }))
      .resolves.toBeNull();
  });

  it('returns the admin id when the admin does operate a supplier profile', async () => {
    prisma.supplierProfile.findFirst.mockResolvedValue({ id: 'profile-1' });

    await expect(resolveSupplierIdForUser({ id: 'admin-1', roles: ['admin'], email: 'a@test.com' }))
      .resolves.toBe('admin-1');
  });

  it('never queries membership without an email (Prisma would match the first member)', async () => {
    prisma.teamMember.findFirst.mockResolvedValue({ roles: ['admin'], role: 'admin', supplierId: 'someone-else' });

    // No user, or a user object with no email: resolving must not invent a match.
    await expect(resolveSupplierIdForUser(null)).resolves.toBeNull();
    await expect(resolveSupplierIdForUser({ id: 'x', roles: ['supplier'] })).resolves.toBeNull();

    expect(prisma.teamMember.findFirst).not.toHaveBeenCalled();
  });

  it('agrees with resolveSupplier, so the two paths cannot drift', async () => {
    mockMembership({ roles: ['editor'], role: 'editor', supplierId: 'owner-1' });

    const req = request();
    await run(resolveSupplier, req);

    await expect(resolveSupplierIdForUser({ ...MEMBER })).resolves.toBe(req.supplierId);
  });
});

describe('membership lookups', () => {
  it('resolveSupplier then requireTeamPermission works on the same route', async () => {
    mockMembership({ roles: ['editor', 'finance'], role: 'editor', supplierId: 'owner-1' });

    const req = request();
    const first = await run(resolveSupplier, req);
    expect(first).toBeUndefined();
    expect(req.supplierId).toBe('owner-1');

    // The permission check must still see the roles from the cached record.
    const second = await run(requireTeamPermission('bookings.view'), req);
    expect(second).toBeUndefined();
    expect(req.teamRoles).toEqual(['editor', 'finance']);
  });

  it('works when the permission middleware runs first', async () => {
    mockMembership({ roles: ['editor'], role: 'editor', supplierId: 'owner-1' });

    const req = request();
    expect(await run(requireTeamPermission('bookings.view'), req)).toBeUndefined();
    expect(await run(resolveSupplier, req)).toBeUndefined();
    expect(req.supplierId).toBe('owner-1');
  });

  it('does the DB lookup once per cache entry', async () => {
    mockMembership({ roles: ['editor'], role: 'editor', supplierId: 'owner-1' });

    const req = request();
    await run(resolveSupplier, req);
    await run(requireTeamPermission('bookings.view'), req);

    expect(prisma.teamMember.findFirst).toHaveBeenCalledTimes(1);
  });
});

describe('permissions', () => {
  it('unions the permissions of two roles', async () => {
    mockMembership({ roles: ['editor', 'finance'], role: 'editor', supplierId: 'owner-1' });

    expect(await run(requireTeamPermission('bookings.view'), request())).toBeUndefined();
    mockCacheStore.clear();
    expect(await run(requireTeamPermission('payouts.view'), request())).toBeUndefined();
  });

  it('denies a permission no selected role grants', async () => {
    mockMembership({ roles: ['support'], role: 'support', supplierId: 'owner-1' });

    const error = await run(requireTeamPermission('payouts.view'), request());
    expect(error?.statusCode).toBe(403);
  });

  it('requireTeamRole passes when ANY selected role is allowed', async () => {
    mockMembership({ roles: ['editor', 'finance'], role: 'editor', supplierId: 'owner-1' });

    expect(await run(requireTeamRole('admin', 'finance'), request())).toBeUndefined();

    mockCacheStore.clear();
    mockMembership({ roles: ['support'], role: 'support', supplierId: 'owner-1' });
    const error = await run(requireTeamRole('admin', 'finance'), request());
    expect(error?.statusCode).toBe(403);
  });

  it('falls back to the legacy single role column', async () => {
    mockMembership({ roles: null, role: 'editor', supplierId: 'owner-1' });

    expect(await run(requireTeamPermission('bookings.view'), request())).toBeUndefined();
  });

  it('rejects non-members', async () => {
    mockMembership(null);

    expect((await run(resolveSupplier, request()))?.statusCode).toBe(403);
    expect((await run(requireTeamPermission('bookings.view'), request()))?.statusCode).toBe(403);
  });

  it('treats the owner as an all-access admin', async () => {
    prisma.supplierProfile.findFirst.mockResolvedValue({ id: 'profile-1' });

    const req = request();
    expect(await run(requireTeamPermission('payouts.view'), req)).toBeUndefined();
    expect(req.teamRoles).toEqual(['admin']);
    expect(req.teamSupplierId).toBe('profile-1');
  });
});
