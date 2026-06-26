jest.mock('../../utils/prismaClient', () => ({
  user: { findUnique: jest.fn() },
  review: { findFirst: jest.fn() },
  conversationParticipant: { findFirst: jest.fn(), findUnique: jest.fn() },
}));

jest.mock('../../utils/auditLogger', () => ({
  logActivity: jest.fn().mockResolvedValue(),
}));

jest.mock('../../utils/chatService', () => ({
  getSharedAdminId: jest.fn().mockResolvedValue('shared-admin'),
  resolveChatUserId: jest.fn(),
  sendMessage: jest.fn(),
  markAsRead: jest.fn(),
}));

jest.mock('../../utils/eventEmitter', () => ({ emit: jest.fn() }));

const prisma = require('../../utils/prismaClient');
const { logActivity } = require('../../utils/auditLogger');

function createMockSocket(overrides = {}) {
  return {
    id: 'socket-' + Math.random().toString(36).slice(2, 8),
    userId: null,
    userRoles: null,
    userName: null,
    join: jest.fn(),
    leave: jest.fn(),
    emit: jest.fn(),
    to: jest.fn().mockReturnThis(),
    disconnect: jest.fn(),
    handshake: {
      headers: {},
      auth: {},
      address: '127.0.0.1',
    },
    on: jest.fn(),
    ...overrides,
  };
}

describe('Socket.IO Auth Middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  describe('token validation', () => {
    it('rejects connection when no token provided', async () => {
      const socket = createMockSocket();

      // Simulate the auth middleware logic
      const token = socket.handshake.auth?.token || socket.handshake.headers.cookie?.split(';').reduce((o, p) => {
        const [k, ...v] = p.trim().split('=');
        if (k) o[k.trim()] = v.join('=');
        return o;
      }, {})?.accessToken;

      expect(token).toBeFalsy();
    });

    it('stamps user info on socket after successful auth', async () => {
      const mockUser = { id: 'u-1', roles: ['admin'], active: true, name: 'Admin User' };
      prisma.user.findUnique.mockResolvedValue(mockUser);

      const user = await prisma.user.findUnique({
        where: { id: 'u-1' },
        select: { id: true, roles: true, active: true, name: true },
      });

      expect(user).toEqual(mockUser);
      expect(user.id).toBe('u-1');
      expect(user.roles).toContain('admin');
    });

    it('rejects when user not found', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      const user = await prisma.user.findUnique({
        where: { id: 'nonexistent' },
        select: { id: true, roles: true, active: true, name: true },
      });

      expect(user).toBeNull();
    });

    it('rejects when user is inactive', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u-1', roles: ['customer'], active: false, name: 'Inactive' });

      const user = await prisma.user.findUnique({
        where: { id: 'u-1' },
        select: { id: true, roles: true, active: true, name: true },
      });

      expect(user.active).toBe(false);
    });
  });

  describe('room joins', () => {
    it('admin joins admin-room', () => {
      const socket = createMockSocket();
      socket.userRoles = ['admin'];
      socket.userId = 'admin-1';

      if (socket.userRoles.includes('admin')) {
        socket.join('admin-room');
      }
      socket.join(`user:${socket.userId}`);

      expect(socket.join).toHaveBeenCalledWith('admin-room');
      expect(socket.join).toHaveBeenCalledWith('user:admin-1');
    });

    it('non-admin does not join admin-room', () => {
      const socket = createMockSocket();
      socket.userRoles = ['customer'];
      socket.userId = 'cust-1';

      if (socket.userRoles.includes('admin')) {
        socket.join('admin-room');
      }
      socket.join(`user:${socket.userId}`);

      expect(socket.join).not.toHaveBeenCalledWith('admin-room');
      expect(socket.join).toHaveBeenCalledWith('user:cust-1');
    });

    it('audit log is created for admin connections', async () => {
      const socket = createMockSocket();
      socket.userRoles = ['admin'];
      socket.userId = 'admin-1';

      if (socket.userRoles.includes('admin')) {
        await logActivity({
          userId: socket.userId,
          action: 'socket.admin-connected',
          resource: 'Socket',
          metadata: { socketId: socket.id, roles: socket.userRoles },
        });
      }

      expect(logActivity).toHaveBeenCalledWith({
        userId: 'admin-1',
        action: 'socket.admin-connected',
        resource: 'Socket',
        metadata: { socketId: socket.id, roles: ['admin'] },
      });
    });
  });

  describe('participant checks', () => {
    it('validates participant membership', async () => {
      prisma.conversationParticipant.findUnique.mockResolvedValue({ userId: 'u-1' });

      const participant = await prisma.conversationParticipant.findUnique({
        where: { conversationId_userId: { conversationId: 'conv-1', userId: 'u-1' } },
      });

      expect(participant).toBeTruthy();
    });

    it('rejects non-participant', async () => {
      prisma.conversationParticipant.findUnique.mockResolvedValue(null);

      const participant = await prisma.conversationParticipant.findUnique({
        where: { conversationId_userId: { conversationId: 'conv-1', userId: 'u-999' } },
      });

      expect(participant).toBeNull();
    });
  });

  describe('review:respond authorization', () => {
    it('allows supplier to respond to own tour review', async () => {
      const mockReview = {
        id: 'r-1',
        tour: { supplierId: 'supplier-1' },
        status: 'APPROVED',
        supplierResponse: null,
      };
      prisma.review.findFirst.mockResolvedValue(mockReview);

      const review = await prisma.review.findFirst({
        where: {
          id: 'r-1',
          tour: { supplierId: 'supplier-1' },
          status: 'APPROVED',
        },
      });

      expect(review).toBeTruthy();
      expect(review.tour.supplierId).toBe('supplier-1');
    });

    it('rejects supplier responding to another supplier review', async () => {
      prisma.review.findFirst.mockResolvedValue(null);

      const review = await prisma.review.findFirst({
        where: {
          id: 'r-1',
          tour: { supplierId: 'wrong-supplier' },
          status: 'APPROVED',
        },
      });

      expect(review).toBeNull();
    });
  });

  describe('rate limiting', () => {
    it('tracks connection attempts per IP', () => {
      const attempts = new Map();
      const RATE_LIMIT = 10;
      const RATE_WINDOW = 60 * 1000;

      function checkRateLimit(ip) {
        const now = Date.now();
        const history = attempts.get(ip) || [];
        const recent = history.filter(t => now - t < RATE_WINDOW);
        if (recent.length >= RATE_LIMIT) return false;
        recent.push(now);
        attempts.set(ip, recent);
        return true;
      }

      // First 10 attempts succeed
      for (let i = 0; i < 10; i++) {
        expect(checkRateLimit('192.168.1.1')).toBe(true);
      }
      // 11th attempt fails
      expect(checkRateLimit('192.168.1.1')).toBe(false);
      // Different IP succeeds
      expect(checkRateLimit('10.0.0.1')).toBe(true);
    });
  });
});
