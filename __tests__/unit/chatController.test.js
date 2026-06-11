jest.mock('../../utils/chatService');
jest.mock('../../utils/prismaClient', () => ({
  user: { findUnique: jest.fn() },
  conversationParticipant: { findFirst: jest.fn() },
}));

const chatService = require('../../utils/chatService');
const prisma = require('../../utils/prismaClient');
const controller = require('../../controllers/chatController');

describe('chatController', () => {
  let req, res, next, mockIo;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIo = { to: jest.fn().mockReturnThis(), emit: jest.fn() };
    req = {
      query: {},
      params: {},
      body: {},
      user: { id: 'u-1', roles: ['supplier'], permissionKeys: ['chat.suppliers'] },
      app: { get: jest.fn().mockReturnValue(mockIo) },
    };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    next = jest.fn();

    chatService.resolveChatUserId.mockResolvedValue('u-1');
  });

  describe('getConversations', () => {
    it('returns filtered conversations', async () => {
      chatService.getConversations.mockResolvedValue([
        { id: 'c-1', type: 'SUPPLIER_ADMIN', title: 'Support' },
      ]);

      await controller.getConversations(req, res, next);

      expect(chatService.getConversations).toHaveBeenCalledWith('u-1');
      expect(res.json).toHaveBeenCalledWith({
        status: 'success',
        data: { conversations: [{ id: 'c-1', type: 'SUPPLIER_ADMIN', title: 'Support' }] },
      });
    });

    it('filters out conversations user cannot access', async () => {
      req.user = { id: 'admin-1', roles: ['admin'], permissionKeys: ['chat.suppliers'] };
      chatService.getConversations.mockResolvedValue([
        { id: 'c-1', type: 'SUPPLIER_ADMIN', title: 'A' },
        { id: 'c-2', type: 'USER_SUPPORT', title: 'B' },
      ]);

      await controller.getConversations(req, res, next);

      const data = res.json.mock.calls[0][0];
      expect(data.data.conversations).toHaveLength(1);
      expect(data.data.conversations[0].id).toBe('c-1');
    });

    it('allows super_admin to access all types', async () => {
      req.user.permissionKeys = ['super_admin'];
      chatService.getConversations.mockResolvedValue([
        { id: 'c-1', type: 'SUPPLIER_ADMIN' },
        { id: 'c-2', type: 'USER_SUPPORT' },
      ]);

      await controller.getConversations(req, res, next);

      const data = res.json.mock.calls[0][0];
      expect(data.data.conversations).toHaveLength(2);
    });
  });

  describe('getOrCreateConversation', () => {
    it('creates conversation and returns 201', async () => {
      req.body = { recipientId: 'admin-1', type: 'SUPPLIER_ADMIN' };
      prisma.user.findUnique.mockResolvedValue({ id: 'admin-1', roles: ['admin'] });
      chatService.findOrCreateConversation.mockResolvedValue({ id: 'c-1', type: 'SUPPLIER_ADMIN' });

      await controller.getOrCreateConversation(req, res, next);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ conversation: expect.any(Object) }) })
      );
    });

    it('throws 400 when recipientId missing', async () => {
      await controller.getOrCreateConversation(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('throws 400 when recipient is self', async () => {
      req.body = { recipientId: 'u-1' };
      await controller.getOrCreateConversation(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('throws 404 when recipient not found', async () => {
      req.body = { recipientId: 'nonexistent' };
      prisma.user.findUnique.mockResolvedValue(null);
      await controller.getOrCreateConversation(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('auto-determines type SUPPLIER_CUSTOMER when not provided', async () => {
      req.body = { recipientId: 'customer-1' };
      req.user = { id: 'u-1', roles: ['supplier'] };
      prisma.user.findUnique.mockResolvedValue({ id: 'customer-1', roles: ['customer'] });
      chatService.findOrCreateConversation.mockResolvedValue({ id: 'c-1' });

      await controller.getOrCreateConversation(req, res, next);

      expect(chatService.findOrCreateConversation).toHaveBeenCalledWith('u-1', 'customer-1', 'SUPPLIER_CUSTOMER');
    });

    it('auto-determines type SUPPLIER_ADMIN for supplier messaging admin', async () => {
      req.body = { recipientId: 'admin-1' };
      req.user = { id: 'u-1', roles: ['supplier'] };
      prisma.user.findUnique.mockResolvedValue({ id: 'admin-1', roles: ['admin'] });
      chatService.findOrCreateConversation.mockResolvedValue({ id: 'c-1' });

      await controller.getOrCreateConversation(req, res, next);

      expect(chatService.findOrCreateConversation).toHaveBeenCalledWith('u-1', 'admin-1', 'SUPPLIER_ADMIN');
    });

    it('auto-determines type USER_SUPPORT for other cases', async () => {
      req.body = { recipientId: 'user-1' };
      req.user = { id: 'u-1', roles: ['customer'] };
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', roles: ['customer'] });
      chatService.findOrCreateConversation.mockResolvedValue({ id: 'c-1' });

      await controller.getOrCreateConversation(req, res, next);

      expect(chatService.findOrCreateConversation).toHaveBeenCalledWith('u-1', 'user-1', 'USER_SUPPORT');
    });

    it('checks admin permissions for SUPPLIER_ADMIN type', async () => {
      req.body = { recipientId: 'supplier-1', type: 'SUPPLIER_ADMIN' };
      req.user = { id: 'admin-1', roles: ['admin'], permissionKeys: [] };
      prisma.user.findUnique.mockResolvedValue({ id: 'supplier-1', roles: ['supplier'] });

      await controller.getOrCreateConversation(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    });
  });

  describe('getMessages', () => {
    it('returns messages with default limit', async () => {
      req.params = { id: 'c-1' };
      chatService.getMessages.mockResolvedValue({ messages: [], hasMore: false, nextCursor: null });

      await controller.getMessages(req, res, next);

      expect(chatService.getMessages).toHaveBeenCalledWith('c-1', 'u-1', undefined, 50);
      expect(res.json).toHaveBeenCalledWith({ status: 'success', data: expect.any(Object) });
    });

    it('uses cursor and limit from query', async () => {
      req.params = { id: 'c-1' };
      req.query = { cursor: '2026-06-01T00:00:00.000Z', limit: '20' };
      chatService.getMessages.mockResolvedValue({ messages: [], hasMore: false, nextCursor: null });

      await controller.getMessages(req, res, next);

      expect(chatService.getMessages).toHaveBeenCalledWith('c-1', 'u-1', '2026-06-01T00:00:00.000Z', 20);
    });

    it('caps limit at 100', async () => {
      req.params = { id: 'c-1' };
      req.query = { limit: '200' };
      chatService.getMessages.mockResolvedValue({ messages: [], hasMore: false, nextCursor: null });

      await controller.getMessages(req, res, next);

      expect(chatService.getMessages).toHaveBeenCalledWith('c-1', 'u-1', undefined, 100);
    });
  });

  describe('sendMessage', () => {
    it('sends message and emits socket events', async () => {
      req.params = { id: 'c-1' };
      req.body = { content: 'Hello' };
      chatService.resolveChatUserId.mockResolvedValue('u-1');
      chatService.sendMessage.mockResolvedValue({ id: 'm-1', content: 'Hello' });
      prisma.conversationParticipant.findFirst.mockResolvedValue({ userId: 'admin-1' });

      await controller.sendMessage(req, res, next);

      expect(chatService.sendMessage).toHaveBeenCalledWith('c-1', 'u-1', 'Hello', { url: undefined, type: undefined });
      expect(res.status).toHaveBeenCalledWith(201);
      expect(mockIo.to).toHaveBeenCalledWith('user:admin-1');
      expect(mockIo.to).toHaveBeenCalledWith('conversation:c-1');
    });

    it('throws 400 when content and attachment both missing', async () => {
      req.params = { id: 'c-1' };
      req.body = {};
      await controller.sendMessage(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('sends message with attachment', async () => {
      req.params = { id: 'c-1' };
      req.body = { content: '', attachmentUrl: 'https://img.jpg', attachmentType: 'image' };
      chatService.sendMessage.mockResolvedValue({ id: 'm-1' });
      prisma.conversationParticipant.findFirst.mockResolvedValue({ userId: 'admin-1' });

      await controller.sendMessage(req, res, next);

      expect(chatService.sendMessage).toHaveBeenCalledWith('c-1', 'u-1', '', { url: 'https://img.jpg', type: 'image' });
    });

    it('handles no io gracefully', async () => {
      req.params = { id: 'c-1' };
      req.app.get.mockReturnValue(null);
      req.body = { content: 'Hello' };
      chatService.sendMessage.mockResolvedValue({ id: 'm-1' });

      await controller.sendMessage(req, res, next);

      expect(res.status).toHaveBeenCalledWith(201);
    });
  });

  describe('markAsRead', () => {
    it('marks as read and emits socket event', async () => {
      req.params = { id: 'c-1' };
      chatService.markAsRead.mockResolvedValue({ lastReadAt: new Date() });
      prisma.conversationParticipant.findFirst.mockResolvedValue({ userId: 'admin-1' });

      await controller.markAsRead(req, res, next);

      expect(chatService.markAsRead).toHaveBeenCalledWith('c-1', 'u-1');
      expect(res.json).toHaveBeenCalledWith({ status: 'success', data: expect.any(Object) });
    });

    it('handles no io gracefully', async () => {
      req.params = { id: 'c-1' };
      req.app.get.mockReturnValue(null);
      chatService.markAsRead.mockResolvedValue({ lastReadAt: new Date() });

      await controller.markAsRead(req, res, next);
      expect(res.json).toHaveBeenCalled();
    });
  });

  describe('getUnreadCount', () => {
    it('returns unread count', async () => {
      chatService.getUnreadCount.mockResolvedValue({ unreadCount: 3 });

      await controller.getUnreadCount(req, res, next);

      expect(chatService.getUnreadCount).toHaveBeenCalledWith('u-1');
      expect(res.json).toHaveBeenCalledWith({ status: 'success', data: { unreadCount: 3 } });
    });
  });

  describe('updateMessage', () => {
    it('updates message and emits socket event', async () => {
      req.params = { id: 'c-1', messageId: 'm-1' };
      req.body = { content: 'Updated' };
      chatService.updateMessage.mockResolvedValue({ id: 'm-1', content: 'Updated', editedAt: new Date() });

      await controller.updateMessage(req, res, next);

      expect(chatService.updateMessage).toHaveBeenCalledWith('c-1', 'm-1', 'u-1', 'Updated');
      expect(mockIo.to).toHaveBeenCalledWith('conversation:c-1');
    });

    it('throws 400 when content missing', async () => {
      req.params = { id: 'c-1', messageId: 'm-1' };
      req.body = {};
      await controller.updateMessage(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('handles no io gracefully', async () => {
      req.params = { id: 'c-1', messageId: 'm-1' };
      req.app.get.mockReturnValue(null);
      req.body = { content: 'Updated' };
      chatService.updateMessage.mockResolvedValue({ id: 'm-1' });

      await controller.updateMessage(req, res, next);
      expect(res.json).toHaveBeenCalled();
    });
  });

  describe('deleteMessage', () => {
    it('deletes message and emits socket event', async () => {
      req.params = { id: 'c-1', messageId: 'm-1' };

      await controller.deleteMessage(req, res, next);

      expect(chatService.deleteMessage).toHaveBeenCalledWith('c-1', 'm-1', 'u-1');
      expect(mockIo.to).toHaveBeenCalledWith('conversation:c-1');
      expect(res.json).toHaveBeenCalledWith({ status: 'success', data: null });
    });

    it('handles no io gracefully', async () => {
      req.params = { id: 'c-1', messageId: 'm-1' };
      req.app.get.mockReturnValue(null);

      await controller.deleteMessage(req, res, next);
      expect(res.json).toHaveBeenCalled();
    });
  });

  describe('deleteConversation', () => {
    it('deletes conversation and emits global event', async () => {
      req.params = { id: 'c-1' };

      await controller.deleteConversation(req, res, next);

      expect(chatService.deleteConversation).toHaveBeenCalledWith('c-1', 'u-1');
      expect(mockIo.emit).toHaveBeenCalledWith('chat:conversation-deleted', { conversationId: 'c-1' });
      expect(res.json).toHaveBeenCalledWith({ status: 'success', data: null });
    });

    it('handles no io gracefully', async () => {
      req.params = { id: 'c-1' };
      req.app.get.mockReturnValue(null);

      await controller.deleteConversation(req, res, next);
      expect(res.json).toHaveBeenCalled();
    });
  });

  describe('uploadImage', () => {
    it('returns file URL when file provided', async () => {
      req.file = { path: 'https://cdn.example.com/img.jpg' };

      await controller.uploadImage(req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        status: 'success',
        data: { url: 'https://cdn.example.com/img.jpg', type: 'image' },
      });
    });

    it('throws 400 when no file provided', async () => {
      await controller.uploadImage(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });
  });
});
