const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const chatService = require('../utils/chatService');
const { isValidCloudinaryUrl } = require('../utils/cloudinaryHelper');

function canAccessType(user, type) {
  // Full dashboard access
  const keys = user.permissionKeys || [];
  if (keys.includes('dashboard.*')) return true;

  // Additive role → type mapping. A user may hold several chat-relevant roles
  // (e.g. a supplier + expedition operator, or a customer who also runs a
  // supplier profile), so we allow the UNION of every role's conversation
  // types instead of returning on the first matching role. Access to message
  // bodies is still strictly scoped by participation (chatService queries by
  // the caller's userId), so widening type visibility cannot leak other
  // users' conversations.
  const allowed = new Set();
  if (user.roles?.includes('customer')) {
    // Travio + Expedition travelers converse with suppliers/operators and
    // with platform support.
    allowed.add('SUPPLIER_CUSTOMER');
    allowed.add('EXPEDITION_CUSTOMER');
    allowed.add('USER_SUPPORT');
  }
  if (user.roles?.includes('supplier')) {
    allowed.add('SUPPLIER_ADMIN');
    allowed.add('SUPPLIER_CUSTOMER');
  }
  if (user.roles?.includes('expedition')) {
    allowed.add('EXPEDITION_CUSTOMER');
  }

  if (allowed.has(type)) return true;

  // Admin / explicitly-granted permission keys.
  if (type === 'SUPPLIER_ADMIN') return keys.includes('chat.suppliers');
  if (type === 'USER_SUPPORT') return keys.includes('chat.customers');
  if (type === 'EXPEDITION_CUSTOMER') return keys.includes('chat.expedition');
  return false;
}

exports.getAdminSupport = catchAsync(async (req, res) => {
  const adminId = await chatService.getSharedAdminId();
  if (!adminId) {
    throw new AppError('Admin support is not configured yet', 404);
  }
  res.json({ status: 'success', data: { adminId } });
});

exports.getExpeditionSupport = catchAsync(async (req, res) => {
  const expeditionId = await chatService.getSharedExpeditionId();
  if (!expeditionId) {
    throw new AppError('Expedition support is not configured yet', 404);
  }
  res.json({ status: 'success', data: { expeditionId } });
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
  const isSenderExpedition = req.user.roles.includes('expedition');

  let type = requestedType;
  if (!type) {
    if (isSenderSupplier && recipient.roles.includes('customer')) {
      type = 'SUPPLIER_CUSTOMER';
    } else if (isSenderSupplier || recipient.roles.includes('supplier') || recipient.roles.includes('admin')) {
      type = 'SUPPLIER_ADMIN';
    } else if (isSenderExpedition || recipient.roles.includes('expedition')) {
      type = 'EXPEDITION_CUSTOMER';
    } else {
      type = 'USER_SUPPORT';
    }
  }

  if ((req.user.roles.includes('admin') || req.user.roles.includes('expedition')) && (type === 'SUPPLIER_ADMIN' || type === 'USER_SUPPORT' || type === 'EXPEDITION_CUSTOMER') && !canAccessType(req.user, type)) {
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

  if (content && content.length > 5000) {
    throw new AppError('Message too long (max 5000 characters)', 400);
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
  // Optional ?type= filter (comma-separated, e.g. ?type=SUPPLIER_ADMIN) so the
  // supplier dashboard bubble only counts the chatrooms it displays. No param =
  // all conversation types (backward compatible).
  const raw = req.query.type || req.query.types;
  const types = typeof raw === 'string' && raw.trim()
    ? raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    : null;
  const result = await chatService.getUnreadCount(req.user.id, types);
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

// "Delete for me": hide a message from the SENDER's own view only. The other
// participant keeps it, so we broadcast only to the deleter's own sessions
// (user room), never to the conversation room.
exports.hideMessageForMe = catchAsync(async (req, res) => {
  const { id, messageId } = req.params;

  const resolvedUserId = await chatService.hideMessageForMe(id, messageId, req.user.id);

  const io = req.app.get('io');
  if (io) {
    io.to(`user:${resolvedUserId}`).emit('chat:message-deleted-for-me', {
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
