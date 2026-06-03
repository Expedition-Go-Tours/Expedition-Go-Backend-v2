const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const chatService = require('../utils/chatService');

exports.getConversations = catchAsync(async (req, res) => {
  const conversations = await chatService.getConversations(req.user.id);

  const withUnread = await Promise.all(conversations.map(async (conv) => {
    const lastMsg = conv.messages[0];
    const unread = lastMsg && lastMsg.senderId !== req.user.id
      ? 1
      : 0;
    return { ...conv, unreadCount: unread };
  }));

  res.json({ status: 'success', data: { conversations: withUnread } });
});

exports.getOrCreateConversation = catchAsync(async (req, res) => {
  const { recipientId } = req.body;

  if (!recipientId) {
    throw new AppError('recipientId is required', 400);
  }

  if (recipientId === req.user.id) {
    throw new AppError('Cannot create conversation with yourself', 400);
  }

  const recipient = await prisma.user.findUnique({
    where: { id: recipientId },
    select: { id: true, roles: true }
  });

  if (!recipient) {
    throw new AppError('Recipient not found', 404);
  }

  const isSupplier = req.user.roles.includes('supplier');
  if (isSupplier && !recipient.roles.includes('admin')) {
    throw new AppError('Suppliers can only message admins', 403);
  }

  const conversation = await chatService.findOrCreateConversation(
    req.user.id,
    recipientId,
    isSupplier ? 'SUPPLIER_ADMIN' : 'USER_SUPPORT'
  );

  res.status(201).json({ status: 'success', data: { conversation } });
});

exports.getMessages = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { cursor, limit = 50 } = req.query;

  const result = await chatService.getMessages(id, req.user.id, cursor, Math.min(parseInt(limit), 100));

  res.json({ status: 'success', data: result });
});

exports.sendMessage = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { content, attachmentUrl, attachmentType } = req.body;

  if (!content && !attachmentUrl) {
    throw new AppError('Message content or attachment is required', 400);
  }

  const message = await chatService.sendMessage(id, req.user.id, content || '', {
    url: attachmentUrl,
    type: attachmentType,
  });

  const io = req.app.get('io');
  if (io) {
    const effectiveUserId = await chatService.resolveChatUserId(req.user.id);
    const participant = await prisma.conversationParticipant.findFirst({
      where: { conversationId: id, userId: { not: effectiveUserId } },
      select: { userId: true }
    });
    if (participant) {
      io.to(`user:${participant.userId}`).emit('chat:message', {
        conversationId: id,
        message,
      });
    }
  }

  res.status(201).json({ status: 'success', data: { message } });
});

exports.markAsRead = catchAsync(async (req, res) => {
  const { id } = req.params;

  const result = await chatService.markAsRead(id, req.user.id);

  const io = req.app.get('io');
  if (io) {
    const effectiveUserId = await chatService.resolveChatUserId(req.user.id);
    const participant = await prisma.conversationParticipant.findFirst({
      where: { conversationId: id, userId: { not: effectiveUserId } },
      select: { userId: true }
    });
    if (participant) {
      io.to(`user:${participant.userId}`).emit('chat:mark-read', {
        conversationId: id,
        readBy: req.user.id,
        readAt: result.lastReadAt,
      });
    }
  }

  res.json({ status: 'success', data: result });
});

exports.getUnreadCount = catchAsync(async (req, res) => {
  const result = await chatService.getUnreadCount(req.user.id);
  res.json({ status: 'success', data: result });
});

exports.uploadImage = catchAsync(async (req, res) => {
  if (!req.file) {
    throw new AppError('No file provided', 400);
  }
  res.json({
    status: 'success',
    data: {
      url: req.file.path,
      type: 'image',
    },
  });
});
