const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const chatService = require('../utils/chatService');

exports.getConversations = catchAsync(async (req, res) => {
  const conversations = await chatService.getConversations(req.user.id);
  res.json({ status: 'success', data: { conversations } });
});

exports.getOrCreateConversation = catchAsync(async (req, res) => {
  const { recipientId, type: requestedType } = req.body;

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

  const isSenderSupplier = req.user.roles.includes('supplier');

  let type = requestedType;
  if (!type) {
    if (isSenderSupplier && recipient.roles.includes('customer')) {
      type = 'SUPPLIER_CUSTOMER';
    } else if (isSenderSupplier || recipient.roles.includes('supplier')) {
      type = 'SUPPLIER_ADMIN';
    } else {
      type = 'USER_SUPPORT';
    }
  }

  const conversation = await chatService.findOrCreateConversation(
    req.user.id,
    recipientId,
    type
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
    io.to(`conversation:${id}`).emit('chat:message', {
      conversationId: id,
      message,
    });
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

exports.updateMessage = catchAsync(async (req, res) => {
  const { id, messageId } = req.params;
  const { content } = req.body;

  if (!content) {
    throw new AppError('Message content is required', 400);
  }

  const message = await chatService.updateMessage(id, messageId, req.user.id, content);

  const io = req.app.get('io');
  if (io) {
    io.to(`conversation:${id}`).emit('chat:message-edited', {
      conversationId: id,
      messageId: message.id,
      content: message.content,
      editedAt: message.editedAt,
    });
  }

  res.json({ status: 'success', data: { message } });
});

exports.deleteMessage = catchAsync(async (req, res) => {
  const { id, messageId } = req.params;

  await chatService.deleteMessage(id, messageId, req.user.id);

  const io = req.app.get('io');
  if (io) {
    io.to(`conversation:${id}`).emit('chat:message-deleted', {
      conversationId: id,
      messageId,
    });
  }

  res.json({ status: 'success', data: null });
});

exports.deleteConversation = catchAsync(async (req, res) => {
  const { id } = req.params;

  await chatService.deleteConversation(id, req.user.id);

  const io = req.app.get('io');
  if (io) {
    io.emit('chat:conversation-deleted', { conversationId: id });
  }

  res.json({ status: 'success', data: null });
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
