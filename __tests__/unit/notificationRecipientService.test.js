jest.mock('../../src/core/services/prismaClient', () => ({
  user: { findUnique: jest.fn() },
  supplierNotificationRecipient: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    count: jest.fn(),
    delete: jest.fn(),
  },
}));

const prisma = require('../../src/core/services/prismaClient');
const service = require('../../src/core/services/notificationRecipientService');

const SUPPLIER = 'supplier-1';

function recipient(over = {}) {
  return {
    id: 'r1',
    supplierId: SUPPLIER,
    email: 'second@example.com',
    name: null,
    status: 'VERIFIED',
    preferences: {},
    verifyTokenHash: null,
    tokenExpiresAt: null,
    verifiedAt: new Date(),
    disabledAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...over,
  };
}

describe('notificationRecipientService', () => {
  const ORIGINAL_FLAG = process.env.NOTIFICATION_RECIPIENTS_ENABLED;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue({ email: 'owner@example.com' });
    prisma.supplierNotificationRecipient.count.mockResolvedValue(0);
    prisma.supplierNotificationRecipient.findUnique.mockResolvedValue(null);
    prisma.supplierNotificationRecipient.findMany.mockResolvedValue([]);
    prisma.supplierNotificationRecipient.updateMany.mockResolvedValue({ count: 0 });
  });

  afterAll(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.NOTIFICATION_RECIPIENTS_ENABLED;
    else process.env.NOTIFICATION_RECIPIENTS_ENABLED = ORIGINAL_FLAG;
  });

  describe('input helpers', () => {
    it('normalizes and validates emails', () => {
      expect(service.normalizeEmail('  Foo@Example.COM ')).toBe('foo@example.com');
      expect(service.isValidEmail('a@b.co')).toBe(true);
      expect(service.isValidEmail('nope')).toBe(false);
    });

    it('masks addresses for logs', () => {
      expect(service.maskEmail('someone@example.com')).toBe('so*****@example.com');
    });

    it('whitelists preference keys', () => {
      expect(service.sanitizePreferences({ bookings: false, junk: true, reviews: 'yes' }))
        .toEqual({ bookings: false });
    });
  });

  describe('addRecipient', () => {
    it('rejects an invalid address', async () => {
      await expect(service.addRecipient(SUPPLIER, { email: 'bad' })).rejects.toThrow(/valid email/i);
    });

    it('rejects the account email', async () => {
      await expect(service.addRecipient(SUPPLIER, { email: 'Owner@example.com' }))
        .rejects.toThrow(/account email/i);
    });

    it('enforces the recipient cap', async () => {
      prisma.supplierNotificationRecipient.count.mockResolvedValue(service.MAX_RECIPIENTS);
      await expect(service.addRecipient(SUPPLIER, { email: 'x@y.com' }))
        .rejects.toThrow(/up to/i);
    });

    it('creates a pending row and returns a raw token it never stores', async () => {
      prisma.supplierNotificationRecipient.create.mockImplementation(({ data }) =>
        Promise.resolve(recipient({ ...data, id: 'new-1', status: 'PENDING' })));

      const { record, rawToken } = await service.addRecipient(SUPPLIER, { email: '  Second@Example.com ' }, 'inviter-1');

      expect(record.email).toBe('second@example.com');
      expect(record.status).toBe('PENDING');
      expect(rawToken).toMatch(/^[a-f0-9]{64}$/);
      const saved = prisma.supplierNotificationRecipient.create.mock.calls[0][0].data;
      expect(saved.verifyTokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(saved.verifyTokenHash).not.toBe(rawToken);
      expect(saved.email).toBe('second@example.com');
    });

    it('re-invites an existing address with a fresh token instead of duplicating', async () => {
      prisma.supplierNotificationRecipient.findUnique.mockResolvedValue(recipient({ status: 'DISABLED' }));
      prisma.supplierNotificationRecipient.update.mockImplementation(({ data }) =>
        Promise.resolve(recipient({ ...data, status: 'PENDING' })));

      const { record } = await service.addRecipient(SUPPLIER, { email: 'second@example.com' });

      expect(prisma.supplierNotificationRecipient.create).not.toHaveBeenCalled();
      expect(prisma.supplierNotificationRecipient.update).toHaveBeenCalled();
      expect(record.status).toBe('PENDING');
    });
  });

  describe('verifyByToken', () => {
    it('rejects an unknown token', async () => {
      prisma.supplierNotificationRecipient.findUnique.mockResolvedValue(null);
      await expect(service.verifyByToken('deadbeef')).rejects.toThrow(/not valid/i);
    });

    it('rejects an expired token', async () => {
      prisma.supplierNotificationRecipient.findUnique.mockResolvedValue(
        recipient({ status: 'PENDING', tokenExpiresAt: new Date(Date.now() - 1000) }),
      );
      await expect(service.verifyByToken('deadbeef')).rejects.toThrow(/expired/i);
    });

    it('marks the row verified and clears the token', async () => {
      prisma.supplierNotificationRecipient.findUnique.mockResolvedValue(
        recipient({ status: 'PENDING', tokenExpiresAt: new Date(Date.now() + 60_000) }),
      );
      prisma.supplierNotificationRecipient.update.mockResolvedValue(recipient({ status: 'VERIFIED' }));

      const result = await service.verifyByToken('deadbeef');

      expect(result.status).toBe('VERIFIED');
      const patch = prisma.supplierNotificationRecipient.update.mock.calls[0][0].data;
      expect(patch.status).toBe('VERIFIED');
      expect(patch.verifyTokenHash).toBeNull();
    });
  });

  describe('resolveRecipients', () => {
    it('returns only the primary while the feature flag is off', async () => {
      delete process.env.NOTIFICATION_RECIPIENTS_ENABLED;
      prisma.supplierNotificationRecipient.findMany.mockResolvedValue([recipient()]);

      const out = await service.resolveRecipients(SUPPLIER, 'bookings');

      expect(out).toEqual([{ email: 'owner@example.com', recipientId: null }]);
      expect(prisma.supplierNotificationRecipient.findMany).not.toHaveBeenCalled();
    });

    it('adds verified extras, honours per-category opt-outs and dedupes', async () => {
      process.env.NOTIFICATION_RECIPIENTS_ENABLED = 'true';
      prisma.supplierNotificationRecipient.findMany.mockResolvedValue([
        recipient({ id: 'r1', email: 'a@example.com' }),
        recipient({ id: 'r2', email: 'b@example.com', preferences: { bookings: false } }),
        recipient({ id: 'r3', email: 'owner@example.com' }), // duplicate of primary
      ]);

      const out = await service.resolveRecipients(SUPPLIER, 'bookings');

      expect(out).toEqual([
        { email: 'owner@example.com', recipientId: null },
        { email: 'a@example.com', recipientId: 'r1' },
      ]);
    });

    it('queries only VERIFIED recipients', async () => {
      process.env.NOTIFICATION_RECIPIENTS_ENABLED = 'true';
      await service.resolveRecipients(SUPPLIER, 'payments');

      expect(prisma.supplierNotificationRecipient.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { supplierId: SUPPLIER, status: 'VERIFIED' } }),
      );
    });
  });

  describe('disableByEmail / disableById', () => {
    it('normalizes the address before disabling', async () => {
      prisma.supplierNotificationRecipient.updateMany.mockResolvedValue({ count: 1 });
      await service.disableByEmail('  Second@Example.com ', 'hard_bounce');

      expect(prisma.supplierNotificationRecipient.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: 'second@example.com', status: { not: 'DISABLED' } },
        }),
      );
    });

    it('targets a single row by id', async () => {
      await service.disableById('r1', 'complaint');
      expect(prisma.supplierNotificationRecipient.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'r1', status: { not: 'DISABLED' } } }),
      );
    });
  });

  describe('unsubscribe', () => {
    it('signs and verifies an unsubscribe token', () => {
      const token = service.signUnsubscribeToken('r1');
      expect(service.verifyUnsubscribeToken('r1', token)).toBe(true);
      expect(service.verifyUnsubscribeToken('r2', token)).toBe(false);
    });
  });
});
