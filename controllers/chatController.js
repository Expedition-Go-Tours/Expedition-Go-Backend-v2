const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const chatService = require('../utils/chatService');
const { isValidCloudinaryUrl } = require('../utils/cloudinaryHelper');

function canAccessType(user, type) {
  if (!user.roles?.includes('admin')) return true;
  const keys = user.permissionKeys || [];
  if (keys.includes('dashboard.*')) return true;
  if (type === 'SUPPLIER_ADMIN') return keys.includes('chat.suppliers');
  if (type === 'USER_SUPPORT') return keys.includes('chat.customers');
  return false;
}

exports.getAdminSupport = catchAsync(async (req, res) => {
  const adminId = await chatService.getSharedAdminId();
  if (!adminId) {
    throw new AppError('Admin support is not configured yet', 404);
  }
  res.json({ status: 'success', data: { adminId } });
});

exports.getConversations = catchAsync(async (req, res) => {
  const conversations = await chatService.getConversations(req.user.id);
  const filtered = conversations.filter((c) => canAccessType(req.user, c.type));
  res.json({ status: 'success', data: { conversations: filtered } });
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
    if (isSenderSupplier && recipient.roles.includes('customer') && !recipient.roles.includes('admin')) {
      type = 'SUPPLIER_CUSTOMER';
    } else if (isSenderSupplier || recipient.roles.includes('supplier') || recipient.roles.includes('admin')) {
      type = 'SUPPLIER_ADMIN';
    } else {
      type = 'USER_SUPPORT';
    }
  }

  if (req.user.roles.includes('admin') && (type === 'SUPPLIER_ADMIN' || type === 'USER_SUPPORT') && !canAccessType(req.user, type)) {
    throw new AppError('You do not have permission for this conversation type', 403);
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

  if (attachmentUrl && !isValidCloudinaryUrl(attachmentUrl)) {
    throw new AppError('Invalid attachment URL', 400);
  }

  const message = await chatService.sendMessage(id, req.user.id, content || '', {
    url: attachmentUrl,
    type: attachmentType,
  });

  res.status(201).json({ status: 'success', data: { message } });
});

exports.markAsRead = catchAsync(async (req, res) => {
  const { id } = req.params;

  const result = await chatService.markAsRead(id, req.user.id);

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

  const participants = await prisma.conversationParticipant.findMany({
    where: { conversationId: id },
    select: { userId: true }
  });

  await chatService.deleteConversation(id, req.user.id);

  const io = req.app.get('io');
  if (io) {
    for (const p of participants) {
      io.to(`user:${p.userId}`).emit('chat:conversation-deleted', { conversationId: id });
    }
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
