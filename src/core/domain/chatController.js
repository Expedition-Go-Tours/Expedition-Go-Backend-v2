const prisma = require('../services/prismaClient');
const catchAsync = require('../services/catchAsync');
const AppError = require('../services/appError');
const chatService = require('../services/chatService');
const { isValidCloudinaryUrl } = require('../services/cloudinaryHelper');
const { BRANDS } = require('../../../config/brands');

const BRAND_KEYS = Object.keys(BRANDS);

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

/**
 * Who may act on the conversation, and who is actually acting.
 *
 * `chatRoutes` runs a non-blocking supplier resolver before the chat handlers:
 * for an accepted team member it sets `req.supplierId` to the OWNER's user id
 * (their own id for owners, absent for customers). Chat access checks run
 * against that id so a support agent works the supplier's inbox, while
 * authorship stays with the member who typed. For owners and customers the two
 * ids are identical, so behaviour is unchanged.
 */
function chatIdentity(req) {
  const actorId = req.user.id;
  const accessId = req.supplierId || actorId;
  return { actorId, accessId, isTeamMember: accessId !== actorId };
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
  // Admins share one chat identity, so without a brand filter every admin
  // inbox would show every platform's conversations. Customers/suppliers are
  // already isolated by participation.
  const isAdmin = Array.isArray(req.user.roles) && req.user.roles.includes('admin');
  const brandKey = isAdmin
    ? (req.brandKey || chatService.brandKeyFromRoles(req.user.roles))
    : null;
  const { accessId } = chatIdentity(req);
  const conversations = await chatService.getConversations(accessId, brandKey);
  const filtered = conversations.filter((c) => canAccessType(req.user, c.type));
  res.json({ status: 'success', data: { conversations: filtered } });
});

exports.getOrCreateConversation = catchAsync(async (req, res) => {
  const { recipientId, type: requestedType } = req.body;
  if (!recipientId) {
    throw new AppError('recipientId is required', 400);
  }

  const { actorId, accessId } = chatIdentity(req);

  // A member would otherwise be able to open a conversation with their own
  // supplier account; the conversation belongs to the account, not the person.
  if (recipientId === accessId) {
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

  // ── Brand resolution (per-platform isolation) ─────────────────────────
  // Brand-scoped mounts (/api/travioghana/chat, /api/travioafrica/chat)
  // carry the platform in the route, so the server trusts it. The legacy
  // shared mount (/api/chat) has no brand context: supplier and expedition
  // conversations stay resolvable server-side, but a brand-less USER_SUPPORT
  // conversation would be un-routable — reject it rather than guess (a loud
  // 409 beats a silently mis-filed support chat).
  const routeBrand = req.brandKey || null;
  const explicitBrand = typeof req.body.brand === 'string' ? req.body.brand : null;

  if (explicitBrand && !BRAND_KEYS.includes(explicitBrand)) {
    throw new AppError(`Unknown brand '${explicitBrand}'`, 400);
  }
  if (!routeBrand && type === 'USER_SUPPORT' && !explicitBrand) {
    throw new AppError(
      'Support chat must be started from a platform endpoint (missing brand)',
      409,
    );
  }

  const ctx = {};
  if (routeBrand) ctx.routeBrand = routeBrand;
  if (explicitBrand) ctx.explicitBrand = explicitBrand;
  if (typeof req.body.bookingId === 'string' && req.body.bookingId) ctx.bookingId = req.body.bookingId;
  if (typeof req.body.bookingNumber === 'string' && req.body.bookingNumber) ctx.bookingNumber = req.body.bookingNumber;
  if (typeof req.body.tourTitle === 'string' && req.body.tourTitle) ctx.tourTitle = req.body.tourTitle;
  const args = [accessId, recipientId, type];
  if (Object.keys(ctx).length > 0) args.push(ctx);
  const conversation = await chatService.findOrCreateConversation(...args);

  res.status(201).json({ status: 'success', data: { conversation } });
});

exports.getMessages = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { cursor, limit = 50 } = req.query;

  const { actorId, accessId } = chatIdentity(req);
  const result = await chatService.getMessages(
    id,
    accessId,
    cursor,
    Math.min(parseInt(limit), 100),
    actorId,
  );

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

  const { actorId, accessId } = chatIdentity(req);
  const message = await chatService.sendMessage(id, accessId, actorId, content || '', {
    url: attachmentUrl,
    type: attachmentType,
  });

  res.status(201).json({ status: 'success', data: { message } });
});

exports.markAsRead = catchAsync(async (req, res) => {
  const { id } = req.params;

  const { accessId } = chatIdentity(req);
  const result = await chatService.markAsRead(id, accessId);

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
  // Same brand scoping as the conversation list, so the badge cannot count
  // another platform's unread messages.
  const isAdmin = Array.isArray(req.user.roles) && req.user.roles.includes('admin');
  const brandKey = isAdmin
    ? (req.brandKey || chatService.brandKeyFromRoles(req.user.roles))
    : null;
  const { accessId } = chatIdentity(req);
  const result = await chatService.getUnreadCount(accessId, types, brandKey);
  res.json({ status: 'success', data: result });
});

exports.updateMessage = catchAsync(async (req, res) => {
  const { id, messageId } = req.params;
  const { content } = req.body;

  if (!content) {
    throw new AppError('Message content is required', 400);
  }

  const { actorId, accessId } = chatIdentity(req);
  const message = await chatService.updateMessage(id, messageId, accessId, actorId, content);

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

  const { actorId, accessId } = chatIdentity(req);
  await chatService.deleteMessage(id, messageId, accessId, actorId);

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

  const { actorId, accessId } = chatIdentity(req);
  const resolvedUserId = await chatService.hideMessageForMe(id, messageId, accessId, actorId);

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

  const { actorId, accessId, isTeamMember } = chatIdentity(req);
  await chatService.deleteConversation(id, accessId);

  const io = req.app.get('io');
  if (io) {
    for (const p of participants) {
      io.to(`user:${p.userId}`).emit('chat:conversation-deleted', { conversationId: id });
    }
    // A member deletes the supplier's conversation, so the owner needs the
    // same real-time notice the participant loop above would have given them.
    if (isTeamMember) {
      io.to(`user:${accessId}`).emit('chat:conversation-deleted', { conversationId: id });
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
