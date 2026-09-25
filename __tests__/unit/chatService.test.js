jest.mock('../../src/core/services/prismaClient', () => ({
  user: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
  conversation: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  conversationParticipant: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  message: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), count: jest.fn() },
  chatMessageHide: { upsert: jest.fn(), findMany: jest.fn() },
  notification: { updateMany: jest.fn() },
  adminNotification: { updateMany: jest.fn() },
  systemConfig: { findUnique: jest.fn() },
}));

jest.mock('../../src/core/services/queue', () => ({ enqueueNotification: jest.fn() }));
jest.mock('../../src/core/services/adminNotificationService', () => ({ notifyAdmin: jest.fn() }));

const prisma = require('../../src/core/services/prismaClient');
const { enqueueNotification } = require('../../src/core/services/queue');
const { notifyAdmin } = require('../../src/core/services/adminNotificationService');
const chatService = require('../../src/core/services/chatService');

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
    prisma.user.findMany.mockResolvedValue([]);
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
    prisma.chatMessageHide.upsert.mockResolvedValue({});
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

    it('filters out messages the requesting user has hidden (delete for me)', async () => {
      await chatService.getMessages('c-1', 'u-1');
      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ hiddenFor: { none: { userId: 'u-1' } } }) })
      );
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

      const result = await chatService.sendMessage('c-1', 'u-1', 'u-1', 'Hello');

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

      await expect(chatService.sendMessage('c-1', 'u-1', 'u-1', 'Hello')).rejects.toThrow('Conversation not found');
    });

    it('truncates long message content for notification', async () => {
      prisma.conversationParticipant.findUnique.mockResolvedValue({
        ...mockUniqueParticipant,
        conversation: { id: 'c-1', type: 'SUPPLIER_ADMIN', participants: [{ userId: 'admin-1' }] },
      });
      prisma.user.findUnique.mockResolvedValue({ roles: ['supplier'], name: 'Supplier' });
      const longContent = 'x'.repeat(200);

      await chatService.sendMessage('c-1', 'u-1', 'u-1', longContent);

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

      await chatService.sendMessage('c-1', 'u-1', 'u-1', 'Check', { url: 'https://img.jpg', type: 'image' });

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

      await chatService.sendMessage('c-1', 'u-1', 'u-1', 'Hello');

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
      const result = await chatService.updateMessage('c-1', 'm-1', 'u-1', 'u-1', 'Updated');
      expect(prisma.message.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'm-1' }, data: expect.objectContaining({ content: 'Updated' }) })
      );
      expect(result).toBe(mockMessage);
    });

    it('throws when message not found', async () => {
      prisma.message.findFirst.mockResolvedValue(null);
      await expect(chatService.updateMessage('c-1', 'nonexistent', 'u-1', 'u-1', 'test')).rejects.toThrow('Message not found');
    });

    it('throws when a team member tries to edit another person\'s message', async () => {
      prisma.message.findFirst.mockResolvedValue({ ...mockMessage, senderId: 'other-user' });
      await expect(chatService.updateMessage('c-1', 'm-1', 'u-1', 'member-1', 'test')).rejects.toThrow('You can only edit your own messages');
    });
  });

  describe('deleteMessage', () => {
    it('deletes own message', async () => {
      await chatService.deleteMessage('c-1', 'm-1', 'u-1', 'u-1');
      expect(prisma.message.delete).toHaveBeenCalledWith({ where: { id: 'm-1' } });
    });

    it('throws when message not found', async () => {
      prisma.message.findFirst.mockResolvedValue(null);
      await expect(chatService.deleteMessage('c-1', 'nonexistent', 'u-1', 'u-1')).rejects.toThrow('Message not found');
    });

    it('throws when a team member tries to delete another person\'s message', async () => {
      prisma.message.findFirst.mockResolvedValue({ ...mockMessage, senderId: 'other-user' });
      await expect(chatService.deleteMessage('c-1', 'm-1', 'u-1', 'member-1')).rejects.toThrow('You can only delete your own messages');
    });
  });

  describe('hideMessageForMe', () => {
    it('hides own message via idempotent upsert and returns resolved userId', async () => {
      const result = await chatService.hideMessageForMe('c-1', 'm-1', 'u-1', 'u-1');
      expect(result).toBe('u-1');
      expect(prisma.chatMessageHide.upsert).toHaveBeenCalledWith({
        where: { messageId_userId: { messageId: 'm-1', userId: 'u-1' } },
        create: { messageId: 'm-1', userId: 'u-1' },
        update: {},
      });
    });

    it('throws when message not found', async () => {
      prisma.message.findFirst.mockResolvedValue(null);
      await expect(chatService.hideMessageForMe('c-1', 'nonexistent', 'u-1', 'u-1')).rejects.toThrow('Message not found');
    });

    it('throws when a recipient tries to hide someone else message', async () => {
      prisma.message.findFirst.mockResolvedValue({ ...mockMessage, senderId: 'other-user' });
      await expect(chatService.hideMessageForMe('c-1', 'm-1', 'u-1', 'u-1')).rejects.toThrow('You can only delete your own messages');
      expect(prisma.chatMessageHide.upsert).not.toHaveBeenCalled();
    });

    it('does not delete the message row or attachment', async () => {
      await chatService.hideMessageForMe('c-1', 'm-1', 'u-1', 'u-1');
      expect(prisma.message.delete).not.toHaveBeenCalled();
    });
  });

  describe('team members (acting on the supplier account)', () => {
    const memberParticipant = {
      conversation: { id: 'c-1', type: 'SUPPLIER_ADMIN', participants: [{ userId: 'admin-1' }] },
    };

    it('checks participation against the owner while attributing the reply to the member', async () => {
      prisma.conversationParticipant.findUnique.mockResolvedValue(memberParticipant);
      prisma.user.findUnique.mockResolvedValue({ roles: ['supplier'], name: 'Support Agent' });
      enqueueNotification.mockResolvedValue();
      notifyAdmin.mockResolvedValue();

      await chatService.sendMessage('c-1', 'owner-1', 'member-1', 'Hello from support');

      // Access is the supplier account...
      expect(prisma.conversationParticipant.findUnique).toHaveBeenCalledWith({
        where: { conversationId_userId: { conversationId: 'c-1', userId: 'owner-1' } },
        include: expect.any(Object),
      });
      // ...authorship is the member.
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ senderId: 'member-1' }) })
      );
      // The counterpart (admin) is notified once — the member is not a participant.
      const notified = enqueueNotification.mock.calls.map(([arg]) => arg.userId);
      expect(notified).toEqual(['admin-1']);
      // The owner is the one whose read state moves.
      expect(prisma.conversationParticipant.update).toHaveBeenCalledWith({
        where: { conversationId_userId: { conversationId: 'c-1', userId: 'owner-1' } },
        data: { lastReadAt: expect.any(Date) },
      });
    });

    it('refuses a member who is not on the supplier account conversation', async () => {
      prisma.conversationParticipant.findUnique.mockResolvedValue(null);
      prisma.conversationParticipant.findMany.mockResolvedValue([{ userId: 'owner-1' }]);

      await expect(chatService.sendMessage('c-1', 'owner-1', 'member-1', 'Hello')).rejects.toThrow(
        'Conversation not found'
      );
      expect(prisma.message.create).not.toHaveBeenCalled();
    });

    it('lets a member edit and delete only their own messages', async () => {
      prisma.message.findFirst.mockResolvedValue({ ...mockMessage, senderId: 'member-1' });

      await chatService.updateMessage('c-1', 'm-1', 'owner-1', 'member-1', 'Fixing my typo');
      expect(prisma.message.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ content: 'Fixing my typo' }) })
      );

      await chatService.deleteMessage('c-1', 'm-1', 'owner-1', 'member-1');
      expect(prisma.message.delete).toHaveBeenCalledWith({ where: { id: 'm-1' } });
    });

    it('refuses a member editing another member\'s message, but lets the owner moderate it', async () => {
      prisma.message.findFirst.mockResolvedValue({ ...mockMessage, senderId: 'other-member' });

      await expect(
        chatService.updateMessage('c-1', 'm-1', 'owner-1', 'member-1', 'nope')
      ).rejects.toThrow('You can only edit your own messages');

      // The owner acts on their own account (access === actor) and may moderate.
      await chatService.updateMessage('c-1', 'm-1', 'owner-1', 'owner-1', 'removed by owner');
      expect(prisma.message.update).toHaveBeenCalled();
    });

    it('hides messages for the member viewing, not for the owner account', async () => {
      prisma.message.findFirst.mockResolvedValue({ ...mockMessage, senderId: 'member-1' });

      const result = await chatService.hideMessageForMe('c-1', 'm-1', 'owner-1', 'member-1');

      expect(result).toBe('member-1');
      expect(prisma.chatMessageHide.upsert).toHaveBeenCalledWith({
        where: { messageId_userId: { messageId: 'm-1', userId: 'member-1' } },
        create: { messageId: 'm-1', userId: 'member-1' },
        update: {},
      });
    });

    it('lists the supplier conversations for a member while hiding per viewer', async () => {
      prisma.message.findMany.mockResolvedValue([{ id: 'm-1', createdAt: new Date('2026-06-01') }]);

      await chatService.getMessages('c-1', 'owner-1', null, 50, 'member-1');

      expect(prisma.conversationParticipant.findUnique).toHaveBeenCalledWith({
        where: { conversationId_userId: { conversationId: 'c-1', userId: 'owner-1' } }
      });
      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ hiddenFor: { none: { userId: 'member-1' } } }),
        })
      );
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

  describe('brand isolation', () => {
    describe('resolveConversationBrand', () => {
      it('stamps Expedition conversations as Ghana', async () => {
        const brand = await chatService.resolveConversationBrand({
          type: 'EXPEDITION_CUSTOMER',
          participantIds: ['u-1', 'exp-1'],
        });
        expect(brand).toBe('ghana');
      });

      it('derives a supplier conversation brand from the supplier role', async () => {
        prisma.user.findMany.mockResolvedValue([{ roles: ['supplier', 'ghana'] }]);
        const brand = await chatService.resolveConversationBrand({
          type: 'SUPPLIER_ADMIN',
          participantIds: ['u-1', 'admin-1'],
        });
        expect(brand).toBe('ghana');
      });

      it('maps the travioafrica role to the africa brand key', async () => {
        prisma.user.findMany.mockResolvedValue([{ roles: ['supplier', 'travioafrica'] }]);
        const brand = await chatService.resolveConversationBrand({
          type: 'SUPPLIER_CUSTOMER',
          participantIds: ['u-1', 'cust-1'],
        });
        expect(brand).toBe('africa');
      });

      it('falls back to the route brand for support conversations', async () => {
        const brand = await chatService.resolveConversationBrand({
          type: 'USER_SUPPORT',
          participantIds: ['cust-1', 'admin-1'],
          routeBrand: 'africa',
        });
        expect(brand).toBe('africa');
      });

      it('accepts a validated explicit brand as a last resort', async () => {
        const brand = await chatService.resolveConversationBrand({
          type: 'USER_SUPPORT',
          participantIds: ['cust-1', 'admin-1'],
          explicitBrand: 'ghana',
        });
        expect(brand).toBe('ghana');
      });

      it('ignores an unknown explicit brand', async () => {
        const brand = await chatService.resolveConversationBrand({
          type: 'USER_SUPPORT',
          participantIds: ['cust-1', 'admin-1'],
          explicitBrand: 'nope',
        });
        expect(brand).toBeNull();
      });

      it('returns null when nothing can be resolved', async () => {
        const brand = await chatService.resolveConversationBrand({
          type: 'USER_SUPPORT',
          participantIds: ['cust-1', 'admin-1'],
        });
        expect(brand).toBeNull();
      });
    });

    describe('getConversations filtering', () => {
      const withBrand = (id, brand) => ({
        ...mockParticipant,
        conversationId: id,
        conversation: { ...mockConversation, id, brand },
      });

      it('shows only the requested brand to an admin', async () => {
        prisma.conversationParticipant.findMany.mockResolvedValue([
          withBrand('c-ghana', 'ghana'),
          withBrand('c-africa', 'africa'),
        ]);

        const result = await chatService.getConversations('admin-1', 'ghana');

        expect(result.map((c) => c.id)).toEqual(['c-ghana']);
      });

      it('does not leak Ghana conversations into Africa', async () => {
        prisma.conversationParticipant.findMany.mockResolvedValue([
          withBrand('c-ghana', 'ghana'),
          withBrand('c-africa', 'africa'),
        ]);

        const result = await chatService.getConversations('admin-1', 'africa');

        expect(result.map((c) => c.id)).toEqual(['c-africa']);
      });

      it('surfaces unassigned legacy rows on Ghana so nothing is orphaned', async () => {
        prisma.conversationParticipant.findMany.mockResolvedValue([
          withBrand('c-legacy', null),
          withBrand('c-africa', 'africa'),
        ]);

        const result = await chatService.getConversations('admin-1', 'ghana');

        expect(result.map((c) => c.id)).toEqual(['c-legacy']);
      });

      it('applies no brand filter when none is given', async () => {
        prisma.conversationParticipant.findMany.mockResolvedValue([
          withBrand('c-ghana', 'ghana'),
          withBrand('c-africa', 'africa'),
        ]);

        const result = await chatService.getConversations('u-1');

        expect(result).toHaveLength(2);
      });
    });

    describe('getUnreadCount filtering', () => {
      it('applies the brand filter to the count query', async () => {
        prisma.message.count.mockResolvedValueOnce(2);
        prisma.conversationParticipant.findMany.mockResolvedValue([
          { conversationId: 'c-africa', lastReadAt: new Date(0) },
        ]);

        const result = await chatService.getUnreadCount('admin-1', null, 'africa');

        const arg = prisma.conversationParticipant.findMany.mock.calls[0][0];
        expect(arg.where.conversation).toMatchObject({ brand: 'africa' });
        expect(result.unreadCount).toBe(2);
      });

      it('counts Ghana and unassigned rows for the Ghana brand', async () => {
        prisma.message.count.mockResolvedValueOnce(1);
        prisma.conversationParticipant.findMany.mockResolvedValue([
          { conversationId: 'c-1', lastReadAt: new Date(0) },
        ]);

        await chatService.getUnreadCount('admin-1', null, 'ghana');

        const arg = prisma.conversationParticipant.findMany.mock.calls[0][0];
        expect(arg.where.conversation.OR).toEqual([{ brand: 'ghana' }, { brand: null }]);
      });
    });
  });
});
