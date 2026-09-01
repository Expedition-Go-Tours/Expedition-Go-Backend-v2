jest.mock('../../utils/prismaClient', () => ({
  user: { findFirst: jest.fn(), findUnique: jest.fn() },
  conversation: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  conversationParticipant: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  message: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), count: jest.fn() },
  notification: { updateMany: jest.fn() },
  adminNotification: { updateMany: jest.fn() },
  systemConfig: { findUnique: jest.fn() },
}));

jest.mock('../../utils/queue', () => ({ enqueueNotification: jest.fn() }));
jest.mock('../../utils/adminNotificationService', () => ({ notifyAdmin: jest.fn() }));

const prisma = require('../../utils/prismaClient');
const { enqueueNotification } = require('../../utils/queue');
const { notifyAdmin } = require('../../utils/adminNotificationService');
const chatService = require('../../utils/chatService');

describe('chatService', () => {
  const mockUser = { id: 'u-1', name: 'User', photoURL: 'p.jpg', lastLoginAt: new Date(), roles: ['supplier'], firebaseUid: 'fb-1' };
  const mockAdmin = { id: 'admin-1', name: 'Admin', roles: ['admin'] };
  const mockConversation = {
    id: 'c-1',
    type: 'SUPPLIER_ADMIN',
    title: 'Support',
    participants: [{ userId: 'u-1', user: mockUser }, { userId: 'admin-1', user: { ...mockAdmin, photoURL: null, lastLoginAt: null, firebaseUid: null } }],
    messages: [],
  };
  const mockMessage = { id: 'm-1', conversationId: 'c-1', senderId: 'u-1', content: 'Hello', createdAt: new Date(), editedAt: null, sender: mockUser };
  const mockParticipant = { id: 'p-1', userId: 'u-1', conversationId: 'c-1', lastReadAt: new Date(0), conversation: mockConversation };
  const mockUniqueParticipant = { id: 'p-1', userId: 'u-1', conversationId: 'c-1', lastReadAt: new Date(0) };

  beforeEach(() => {
    jest.clearAllMocks();

    prisma.user.findFirst.mockResolvedValue(mockAdmin);
    prisma.user.findUnique.mockResolvedValue(mockUser);
    prisma.conversation.findFirst.mockResolvedValue(mockConversation);
    prisma.conversation.create.mockResolvedValue(mockConversation);
    prisma.conversation.update.mockResolvedValue(mockConversation);
    prisma.conversation.delete.mockResolvedValue();
    prisma.conversationParticipant.findMany.mockResolvedValue([mockParticipant]);
    prisma.conversationParticipant.findUnique.mockResolvedValue(mockUniqueParticipant);
    prisma.conversationParticipant.findFirst.mockResolvedValue(null);
    prisma.conversationParticipant.update.mockResolvedValue({});
    prisma.message.findMany.mockResolvedValue([]);
    prisma.message.findFirst.mockResolvedValue(mockMessage);
    prisma.message.create.mockResolvedValue(mockMessage);
    prisma.message.update.mockResolvedValue(mockMessage);
    prisma.message.delete.mockResolvedValue();
    prisma.message.count.mockResolvedValue(0);
    prisma.notification.updateMany.mockResolvedValue({ count: 1 });
    prisma.adminNotification.updateMany.mockResolvedValue({ count: 1 });
    prisma.systemConfig.findUnique.mockResolvedValue(null);
  });

  describe('getSharedAdminId', () => {
    it('returns admin id and caches result', async () => {
      const first = await chatService.getSharedAdminId();
      expect(first).toBe('admin-1');
      const second = await chatService.getSharedAdminId();
      expect(second).toBe('admin-1');
      expect(prisma.user.findFirst).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolveChatUserId', () => {
    it('returns userId unchanged for non-admin users', async () => {
      prisma.user.findUnique.mockResolvedValue({ roles: ['supplier'] });
      const result = await chatService.resolveChatUserId('u-1');
      expect(result).toBe('u-1');
    });

    it('returns shared admin id for admin users', async () => {
      prisma.user.findUnique.mockResolvedValue({ roles: ['admin'] });
      const result = await chatService.resolveChatUserId('admin-2');
      expect(result).toBe('admin-1');
    });
  });

  describe('findOrCreateConversation', () => {
    it('returns existing conversation when found', async () => {
      const result = await chatService.findOrCreateConversation('u-1', 'admin-1');
      expect(result).toBe(mockConversation);
      expect(prisma.conversation.create).not.toHaveBeenCalled();
    });

    it('creates new conversation when none exists', async () => {
      prisma.conversation.findFirst.mockResolvedValue(null);

      const result = await chatService.findOrCreateConversation('u-1', 'admin-1');

      expect(prisma.conversation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'SUPPLIER_ADMIN',
            participants: expect.objectContaining({ create: expect.arrayContaining([{ userId: 'u-1' }, { userId: 'admin-1' }]) }),
          }),
        })
      );
      expect(result).toBe(mockConversation);
    });

    it('throws when recipient not found', async () => {
      prisma.conversation.findFirst.mockResolvedValue(null);
      prisma.user.findUnique
        .mockResolvedValueOnce(mockUser)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(mockUser)
        .mockResolvedValueOnce(null);

      await expect(chatService.findOrCreateConversation('u-1', 'nonexistent')).rejects.toThrow('Recipient not found');
    });

    it('resolves admin userIds to shared admin id', async () => {
      prisma.conversation.findFirst.mockResolvedValue(null);
      prisma.user.findUnique.mockImplementation(({ where }) => {
        if (where.id === 'admin-2') return Promise.resolve({ roles: ['admin'] });
        if (where.id === 'u-1') return Promise.resolve(mockUser);
        return Promise.resolve(mockAdmin);
      });

      await chatService.findOrCreateConversation('admin-2', 'u-1');

      expect(prisma.conversation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            participants: expect.objectContaining({
              create: expect.arrayContaining([{ userId: 'admin-1' }, { userId: 'u-1' }]),
            }),
          }),
        })
      );
    });
  });

  describe('getConversations', () => {
    it('returns mapped conversations with unread count', async () => {
      prisma.message.count.mockResolvedValue(1);
      prisma.conversationParticipant.findMany.mockResolvedValue([{
        ...mockParticipant,
        conversation: { ...mockConversation, messages: [{ ...mockMessage, createdAt: new Date('2026-06-10') }] },
      }]);

      const result = await chatService.getConversations('u-1');

      expect(result).toHaveLength(1);
      expect(result[0].unreadCount).toBe(1);
      expect(result[0]._participant).toBeDefined();
    });

    it('returns 0 unread when no messages', async () => {
      const result = await chatService.getConversations('u-1');
      expect(result[0].unreadCount).toBe(0);
    });
  });

  describe('getMessages', () => {
    it('returns paginated messages', async () => {
      prisma.message.findMany.mockResolvedValue([mockMessage]);

      const result = await chatService.getMessages('c-1', 'u-1');

      expect(result.messages).toHaveLength(1);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    it('throws when participant not found', async () => {
      prisma.conversationParticipant.findUnique.mockResolvedValue(null);
      await expect(chatService.getMessages('c-1', 'u-1')).rejects.toThrow('Conversation not found');
    });

    it('returns hasMore true when more messages than limit', async () => {
      prisma.message.findMany.mockResolvedValue([mockMessage, mockMessage, mockMessage]);
      const result = await chatService.getMessages('c-1', 'u-1', null, 2);
      expect(result.hasMore).toBe(true);
      expect(result.messages).toHaveLength(2);
    });

    it('uses cursor for pagination when provided', async () => {
      await chatService.getMessages('c-1', 'u-1', '2026-06-10T00:00:00.000Z');
      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ createdAt: expect.any(Object) }) })
      );
    });
  });

  describe('sendMessage', () => {
    it('creates message and updates conversation', async () => {
      prisma.conversationParticipant.findUnique.mockResolvedValue({
        ...mockUniqueParticipant,
        conversation: { id: 'c-1', type: 'SUPPLIER_ADMIN', participants: [{ userId: 'admin-1' }] },
      });
      prisma.user.findUnique.mockResolvedValue({ roles: ['supplier'], name: 'Supplier' });
      enqueueNotification.mockResolvedValue();
      notifyAdmin.mockResolvedValue();

      const result = await chatService.sendMessage('c-1', 'u-1', 'Hello');

      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ content: 'Hello', conversationId: 'c-1' }) })
      );
      expect(prisma.conversation.update).toHaveBeenCalled();
      expect(prisma.conversationParticipant.update).toHaveBeenCalled();
      expect(enqueueNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'admin-1', type: 'NEW_MESSAGE' }));
      expect(notifyAdmin).toHaveBeenCalled();
      expect(result).toBe(mockMessage);
    });

    it('throws when participant not found', async () => {
      prisma.conversationParticipant.findUnique.mockResolvedValue(null);
      prisma.conversationParticipant.findMany.mockResolvedValue([]);

      await expect(chatService.sendMessage('c-1', 'u-1', 'Hello')).rejects.toThrow('Conversation not found');
    });

    it('truncates long message content for notification', async () => {
      prisma.conversationParticipant.findUnique.mockResolvedValue({
        ...mockUniqueParticipant,
        conversation: { id: 'c-1', type: 'SUPPLIER_ADMIN', participants: [{ userId: 'admin-1' }] },
      });
      prisma.user.findUnique.mockResolvedValue({ roles: ['supplier'], name: 'Supplier' });
      const longContent = 'x'.repeat(200);

      await chatService.sendMessage('c-1', 'u-1', longContent);

      expect(enqueueNotification).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'x'.repeat(100) + '...' })
      );
    });

    it('stores attachment when provided', async () => {
      prisma.conversationParticipant.findUnique.mockResolvedValue({
        ...mockUniqueParticipant,
        conversation: { id: 'c-1', type: 'SUPPLIER_ADMIN', participants: [{ userId: 'admin-1' }] },
      });
      prisma.user.findUnique.mockResolvedValue({ roles: ['supplier'], name: 'Supplier' });

      await chatService.sendMessage('c-1', 'u-1', 'Check', { url: 'https://img.jpg', type: 'image' });

      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ attachmentUrl: 'https://img.jpg', attachmentType: 'image' }),
        })
      );
    });

    it('notifies both admin and customer for SUPPLIER_CUSTOMER type', async () => {
      prisma.conversationParticipant.findUnique.mockResolvedValue({
        ...mockUniqueParticipant,
        conversation: {
          id: 'c-1',
          type: 'SUPPLIER_CUSTOMER',
          participants: [{ userId: 'u-1' }, { userId: 'customer-1' }, { userId: 'admin-1' }],
        },
      });
      prisma.user.findUnique.mockResolvedValue({ roles: ['supplier'], name: 'Supplier' });
      enqueueNotification.mockResolvedValue();

      await chatService.sendMessage('c-1', 'u-1', 'Hello');

      const calls = enqueueNotification.mock.calls;
      const customerCalls = calls.filter(c => c[0].userId === 'customer-1');
      expect(customerCalls.length).toBeGreaterThan(0);
    });
  });

  describe('markAsRead', () => {
    it('updates participant lastReadAt', async () => {
      const result = await chatService.markAsRead('c-1', 'u-1');
      expect(prisma.conversationParticipant.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'p-1' }, data: expect.objectContaining({ lastReadAt: expect.any(Date) }) })
      );
      expect(result.lastReadAt).toBeDefined();
    });

    it('throws when participant not found', async () => {
      prisma.conversationParticipant.findUnique.mockResolvedValue(null);
      await expect(chatService.markAsRead('c-1', 'u-1')).rejects.toThrow('Conversation not found');
    });

    it('acknowledges admin notifications for admin users', async () => {
      prisma.user.findUnique.mockResolvedValue({ roles: ['admin'] });

      await chatService.markAsRead('c-1', 'admin-2');

      expect(prisma.adminNotification.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ type: 'NEW_MESSAGE' }) })
      );
    });

    it('updates regular notifications for non-admin users', async () => {
      prisma.user.findUnique.mockResolvedValue({ roles: ['supplier'] });

      await chatService.markAsRead('c-1', 'u-1');

      expect(prisma.notification.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ userId: 'u-1', type: 'NEW_MESSAGE' }) })
      );
    });
  });

  describe('updateMessage', () => {
    it('updates message content', async () => {
      const result = await chatService.updateMessage('c-1', 'm-1', 'u-1', 'Updated');
      expect(prisma.message.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'm-1' }, data: expect.objectContaining({ content: 'Updated' }) })
      );
      expect(result).toBe(mockMessage);
    });

    it('throws when message not found', async () => {
      prisma.message.findFirst.mockResolvedValue(null);
      await expect(chatService.updateMessage('c-1', 'nonexistent', 'u-1', 'test')).rejects.toThrow('Message not found');
    });

    it('throws when sender does not match', async () => {
      prisma.message.findFirst.mockResolvedValue({ ...mockMessage, senderId: 'other-user' });
      await expect(chatService.updateMessage('c-1', 'm-1', 'u-1', 'test')).rejects.toThrow('You can only edit your own messages');
    });
  });

  describe('deleteMessage', () => {
    it('deletes own message', async () => {
      await chatService.deleteMessage('c-1', 'm-1', 'u-1');
      expect(prisma.message.delete).toHaveBeenCalledWith({ where: { id: 'm-1' } });
    });

    it('throws when message not found', async () => {
      prisma.message.findFirst.mockResolvedValue(null);
      await expect(chatService.deleteMessage('c-1', 'nonexistent', 'u-1')).rejects.toThrow('Message not found');
    });

    it('throws when sender does not match', async () => {
      prisma.message.findFirst.mockResolvedValue({ ...mockMessage, senderId: 'other-user' });
      await expect(chatService.deleteMessage('c-1', 'm-1', 'u-1')).rejects.toThrow('You can only delete your own messages');
    });
  });

  describe('deleteConversation', () => {
    it('deletes conversation when participant', async () => {
      prisma.conversationParticipant.findFirst.mockResolvedValue(mockUniqueParticipant);
      await chatService.deleteConversation('c-1', 'u-1');
      expect(prisma.conversation.delete).toHaveBeenCalledWith({ where: { id: 'c-1' } });
    });

    it('throws when not a participant', async () => {
      prisma.conversationParticipant.findFirst.mockResolvedValue(null);
      await expect(chatService.deleteConversation('c-1', 'u-1')).rejects.toThrow('Conversation not found');
    });
  });

  describe('getUnreadCount', () => {
    it('returns total unread count', async () => {
      prisma.message.count
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0);
      prisma.conversationParticipant.findMany.mockResolvedValue([
        { conversationId: 'c-1', lastReadAt: new Date(0) },
        { conversationId: 'c-2', lastReadAt: new Date('2026-06-15') },
      ]);

      const result = await chatService.getUnreadCount('u-1');
      expect(result.unreadCount).toBe(1);
    });

    it('scopes the count to the requested conversation types', async () => {
      prisma.message.count.mockResolvedValueOnce(3);
      prisma.conversationParticipant.findMany.mockResolvedValue([
        { conversationId: 'c-1', lastReadAt: new Date(0) },
      ]);

      const result = await chatService.getUnreadCount('u-1', ['SUPPLIER_ADMIN']);

      const findManyArg = prisma.conversationParticipant.findMany.mock.calls[0][0];
      expect(findManyArg.where).toMatchObject({
        conversation: { type: { in: ['SUPPLIER_ADMIN'] } },
      });
      expect(result.unreadCount).toBe(3);
    });

    it('counts all conversations when no types are provided', async () => {
      prisma.message.count.mockResolvedValueOnce(5);
      prisma.conversationParticipant.findMany.mockResolvedValue([
        { conversationId: 'c-1', lastReadAt: new Date(0) },
      ]);

      await chatService.getUnreadCount('u-1', null);

      const findManyArg = prisma.conversationParticipant.findMany.mock.calls[0][0];
      expect(findManyArg.where).toMatchObject({ userId: 'u-1' });
      expect(findManyArg.where.conversation).toBeUndefined();
    });
  });
});
