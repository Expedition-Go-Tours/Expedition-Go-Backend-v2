const prisma = require('./prismaClient');
const { enqueueNotification, enqueueEmail } = require('./queue');
const { notifyAdmin } = require('./adminNotificationService');
const { deleteCloudinaryImage } = require('./cloudinaryHelper');
const chatInbound = require('./chatInbound');
const emailUrls = require('../config/emailUrls');
const logger = require('./logger');

let _sharedAdminId = null;

async function getSharedAdminId() {
  if (!_sharedAdminId) {
    const config = await prisma.systemConfig.findUnique({
      where: { key: 'chat.admin_id' },
      select: { value: true }
    });
    if (config?.value) {
      _sharedAdminId = config.value;
    } else {
      const admin = await prisma.user.findFirst({
        where: { roles: { has: 'admin' } },
        orderBy: { createdAt: 'asc' },
        select: { id: true }
      });
      _sharedAdminId = admin?.id || null;
    }
  }
  return _sharedAdminId;
}

let _sharedExpeditionId = null;

async function getSharedExpeditionId() {
  if (!_sharedExpeditionId) {
    const config = await prisma.systemConfig.findUnique({
      where: { key: 'chat.expedition_id' },
      select: { value: true }
    });
    if (config?.value) {
      _sharedExpeditionId = config.value;
    } else {
      const expedition = await prisma.user.findFirst({
        where: { roles: { has: 'expedition' } },
        orderBy: { createdAt: 'asc' },
        select: { id: true }
      });
      _sharedExpeditionId = expedition?.id || null;
    }
  }
  return _sharedExpeditionId;
}

async function resolveChatUserId(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { roles: true }
  });
  if (!user) return userId;
  // Customers and suppliers are always reachable at their own ID
  if (user.roles.includes('customer') || user.roles.includes('supplier')) return userId;
  if (user.roles.includes('expedition')) {
    const sharedId = await getSharedExpeditionId();
    return sharedId || userId;
  }
  if (user.roles.includes('admin')) {
    const sharedId = await getSharedAdminId();
    return sharedId || userId;
  }
  return userId;
}

async function findOrCreateConversation(senderId, recipientId, type = 'SUPPLIER_ADMIN') {
  const originalSenderId = senderId;
  const originalRecipientId = recipientId;
  senderId = await resolveChatUserId(senderId);
  recipientId = await resolveChatUserId(recipientId);
  console.log('[ChatService] findOrCreateConversation:', { originalSenderId, senderId, originalRecipientId, recipientId, type });

  const existing = await prisma.conversation.findFirst({
    where: {
      type,
      AND: [
        { participants: { some: { userId: senderId } } },
        { participants: { some: { userId: recipientId } } }
      ]
    },
    include: {
      participants: {
        include: { user: { select: { id: true, name: true, photoURL: true, lastLoginAt: true, roles: true, firebaseUid: true } } }
      },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: { sender: { select: { id: true, name: true, photoURL: true, lastLoginAt: true, firebaseUid: true, roles: true } } }
      }
    }
  });

  if (existing) {
    console.log('[ChatService] findOrCreateConversation: FOUND EXISTING', { conversationId: existing.id, existingParticipantIds: existing.participants.map(p => p.userId) });
    return existing;
  }

  console.log('[ChatService] findOrCreateConversation: CREATING NEW conversation');
  const [sender, recipient] = await Promise.all([
    prisma.user.findUnique({
      where: { id: senderId },
      select: { id: true, name: true, roles: true },
    }),
    prisma.user.findUnique({
      where: { id: recipientId },
      select: { id: true, name: true, roles: true },
    }),
  ]);

  if (!recipient) throw Object.assign(new Error('Recipient not found'), { statusCode: 404 });

  // Title should reflect the non-admin participant
  const title = recipient.roles?.includes('admin')
    ? sender?.name || recipient.name
    : recipient.name;

  const conversation = await prisma.conversation.create({
    data: {
      type,
      title,
      participants: {
        create: [
          { userId: senderId },
          { userId: recipientId },
        ]
      }
    },
    include: {
      participants: {
        include: { user: { select: { id: true, name: true, photoURL: true, lastLoginAt: true, roles: true, firebaseUid: true } } }
      },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: { sender: { select: { id: true, name: true, photoURL: true, lastLoginAt: true, firebaseUid: true, roles: true } } }
      }
    }
  });

  return conversation;
}

async function getConversations(userId) {
  userId = await resolveChatUserId(userId);

  const participants = await prisma.conversationParticipant.findMany({
    where: { userId },
    include: {
      conversation: {
        include: {
          participants: {
            include: { user: { select: { id: true, name: true, photoURL: true, lastLoginAt: true, roles: true, firebaseUid: true } } }
          },
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: { sender: { select: { id: true, name: true, photoURL: true, lastLoginAt: true, firebaseUid: true, roles: true } } }
          }
        }
      }
    },
    orderBy: { conversation: { updatedAt: 'desc' } }
  });

  const unreadCounts = await Promise.all(
    participants.map(p =>
      prisma.message.count({
        where: {
          conversationId: p.conversationId,
          createdAt: { gt: p.lastReadAt },
        },
      })
    )
  );

  return participants.map((p, i) => ({
    ...p.conversation,
    unreadCount: unreadCounts[i],
    lastReadAt: p.lastReadAt,
    _participant: { id: p.id, lastReadAt: p.lastReadAt },
  }));
}

async function getMessages(conversationId, userId, cursor, limit = 50) {
    userId = await resolveChatUserId(userId);
  
    const participant = await prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId } }
    });
  
    if (!participant) throw Object.assign(new Error('Conversation not found'), { statusCode: 404 });
  
    const where = { conversationId };
    if (cursor) {
      where.createdAt = { lt: new Date(cursor) };
    }
  
    const messages = await prisma.message.findMany({
      where: {
        ...where,
        // "Delete for me": hide messages this user has hidden from their own
        // view only (the row is kept for the other participant).
        hiddenFor: { none: { userId } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      include: {
        sender: { select: { id: true, name: true, photoURL: true, lastLoginAt: true, firebaseUid: true, roles: true } }
      }
    });
  
    const hasMore = messages.length > limit;
    if (hasMore) messages.pop();
  
    return {
      messages: messages.reverse(),
      nextCursor: hasMore ? messages[0]?.createdAt.toISOString() : null,
      hasMore,
    };
  }

async function sendMessage(conversationId, senderId, content, attachment = null) {
  const originalSenderId = senderId;
  senderId = await resolveChatUserId(senderId);

  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId: senderId } },
    include: {
      conversation: {
        select: {
          id: true,
          type: true,
          participants: {
            where: { userId: { not: senderId } },
            select: { userId: true }
          }
        }
      }
    }
  });

  if (!participant) {
    const existingParticipants = await prisma.conversationParticipant.findMany({
      where: { conversationId },
      select: { userId: true }
    });
    console.error('[ChatService] Participant not found:', { conversationId, userId: senderId, resolvedSenderId: senderId, originalSenderId, existingParticipants: existingParticipants.map(p => p.userId) });
    throw Object.assign(new Error('Conversation not found'), { statusCode: 404 });
  }

  const message = await prisma.message.create({
    data: {
      conversationId,
      senderId,
      content,
      attachmentUrl: attachment?.url || null,
      attachmentType: attachment?.type || null,
    },
    include: {
      sender: { select: { id: true, name: true, photoURL: true, lastLoginAt: true, firebaseUid: true, roles: true } }
    }
  });

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() }
  });

  await prisma.conversationParticipant.update({
    where: { conversationId_userId: { conversationId, userId: senderId } },
    data: { lastReadAt: new Date() }
  });

  const recipientIds = participant.conversation.participants
    .map(p => p.userId)
    .filter(id => id !== senderId);
  for (const recipientId of recipientIds) {
    enqueueNotification({
      userId: recipientId,
      type: 'NEW_MESSAGE',
      title: 'New Message',
      message: content.length > 100 ? content.slice(0, 100) + '...' : content,
      data: { conversationId, senderId, conversationType: participant.conversation.type }
    }).catch((err) => console.error('[ChatService] Failed to enqueue notification:', err));
  }

  // Email every other participant with a reply-to address so they can respond
  // from their inbox (best-effort — never blocks the chat write).
  notifyConversationByEmail({
    conversationId,
    type: participant.conversation.type,
    senderId,
    senderName: message.sender?.name || 'Someone',
    content,
  }).catch((err) => console.error('[ChatService] chat email notification failed:', err));

  const sender = await prisma.user.findUnique({
    where: { id: originalSenderId },
    select: { roles: true, name: true }
  });

  let chatType;
  if (participant.conversation.type === 'SUPPLIER_ADMIN') {
    chatType = 'suppliers';
  } else if (participant.conversation.type === 'EXPEDITION_CUSTOMER') {
    chatType = 'expedition';
  } else {
    chatType = 'customers';
  }

  if (sender) {
    if (sender.roles.includes('supplier')) {
      console.log('[ChatService] notifyAdmin called:', { conversationId, conversationType: participant.conversation.type, chatType, senderRoles: sender.roles, senderName: sender.name });
      notifyAdmin({
        type: 'NEW_MESSAGE',
        title: `New message from ${sender.name}`,
        message: content.length > 100 ? content.slice(0, 100) + '...' : content,
        data: { conversationId, senderId, senderName: sender.name, messageId: message.id, chatType, conversationType: participant.conversation.type }
      });
    }

    if (chatType === 'expedition' && !sender.roles.includes('expedition')) {
      console.log('[ChatService] notifyAdmin expedition:', { conversationId, conversationType: participant.conversation.type, chatType, senderRoles: sender.roles, senderName: sender.name });
      notifyAdmin({
        type: 'NEW_MESSAGE',
        title: `New message from ${sender.name}`,
        message: content.length > 100 ? content.slice(0, 100) + '...' : content,
        data: { conversationId, senderId, senderName: sender.name, messageId: message.id, chatType, conversationType: participant.conversation.type }
      });
    }

    // Storefront visitors messaging the admin "Customer Support" inbox
    // (USER_SUPPORT) must ring the admin bell. Previously only supplier senders
    // and expedition-chat travellers were notified.
    const isInternalSender =
      sender.roles.includes('admin') || sender.roles.includes('expedition');
    if (participant.conversation.type === 'USER_SUPPORT' && !sender.roles.includes('supplier') && !isInternalSender) {
      console.log('[ChatService] notifyAdmin user-support:', { conversationId, chatType, senderName: sender.name });
      notifyAdmin({
        type: 'NEW_MESSAGE',
        title: `New message from ${sender.name}`,
        message: content.length > 100 ? content.slice(0, 100) + '...' : content,
        data: { conversationId, senderId, senderName: sender.name, messageId: message.id, chatType: 'customers', conversationType: participant.conversation.type }
      });
    }
  }

  return message;
}

async function markAsRead(conversationId, userId) {
  const originalUserId = userId;
  userId = await resolveChatUserId(userId);

  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } }
  });

  if (!participant) throw Object.assign(new Error('Conversation not found'), { statusCode: 404 });

  await prisma.conversationParticipant.update({
    where: { id: participant.id },
    data: { lastReadAt: new Date() }
  });

  const user = await prisma.user.findUnique({
    where: { id: originalUserId },
    select: { roles: true }
  });

  if (user?.roles?.includes('admin')) {
    await prisma.adminNotification.updateMany({
      where: {
        type: 'NEW_MESSAGE',
        acknowledged: false,
        data: { path: ['conversationId'], equals: conversationId }
      },
      data: { acknowledged: true, acknowledgedAt: new Date(), acknowledgedBy: userId }
    });
  } else {
    await prisma.notification.updateMany({
      where: {
        userId,
        type: 'NEW_MESSAGE',
        read: false,
        data: { path: ['conversationId'], equals: conversationId }
      },
      data: { read: true, readAt: new Date() }
    });
  }

  return { lastReadAt: new Date() };
}

async function updateMessage(conversationId, messageId, userId, content) {
  const resolvedUserId = await resolveChatUserId(userId);

  const message = await prisma.message.findFirst({
    where: { id: messageId, conversationId },
  });

  if (!message) throw Object.assign(new Error('Message not found'), { statusCode: 404 });
  if (message.senderId !== resolvedUserId) throw Object.assign(new Error('You can only edit your own messages'), { statusCode: 403 });

  const updated = await prisma.message.update({
    where: { id: messageId },
    data: { content, editedAt: new Date() },
    include: {
      sender: { select: { id: true, name: true, photoURL: true, lastLoginAt: true, firebaseUid: true, roles: true } }
    }
  });

  return updated;
}

async function deleteMessage(conversationId, messageId, userId) {
  const resolvedUserId = await resolveChatUserId(userId);

  const message = await prisma.message.findFirst({
    where: { id: messageId, conversationId },
  });

  if (!message) throw Object.assign(new Error('Message not found'), { statusCode: 404 });
  if (message.senderId !== resolvedUserId) throw Object.assign(new Error('You can only delete your own messages'), { statusCode: 403 });

  if (message.attachmentUrl) {
    deleteCloudinaryImage(message.attachmentUrl).catch((err) => logger.warn('[chat] deleteCloudinaryImage failed:', err?.message));
  }

  await prisma.message.delete({ where: { id: messageId } });
}

/**
 * "Delete for me": the sender hides a message from their OWN view only.
 * The row and any attachment are kept — the other participant still sees the
 * message. Only the sender may hide their own message (recipients cannot hide
 * anyone's messages). Re-hiding is idempotent via the composite PK.
 */
async function hideMessageForMe(conversationId, messageId, userId) {
  const resolvedUserId = await resolveChatUserId(userId);

  const message = await prisma.message.findFirst({
    where: { id: messageId, conversationId },
    select: { id: true, senderId: true },
  });

  if (!message) throw Object.assign(new Error('Message not found'), { statusCode: 404 });
  if (message.senderId !== resolvedUserId) throw Object.assign(new Error('You can only delete your own messages'), { statusCode: 403 });

  await prisma.chatMessageHide.upsert({
    where: { messageId_userId: { messageId, userId: resolvedUserId } },
    create: { messageId, userId: resolvedUserId },
    update: {},
  });

  return resolvedUserId;
}

async function deleteConversation(conversationId, userId) {
  const resolvedUserId = await resolveChatUserId(userId);

  const participant = await prisma.conversationParticipant.findFirst({
    where: { conversationId, userId: resolvedUserId },
  });

  if (!participant) throw Object.assign(new Error('Conversation not found'), { statusCode: 404 });

  const messagesWithAttachments = await prisma.message.findMany({
    where: { conversationId, attachmentUrl: { not: null } },
    select: { attachmentUrl: true },
  });

  for (const msg of messagesWithAttachments) {
    deleteCloudinaryImage(msg.attachmentUrl).catch((err) => logger.warn('[chat] deleteCloudinaryImage failed:', err?.message));
  }

  await prisma.conversation.delete({ where: { id: conversationId } });
}

/**
 * Total unread messages across the user's conversations.
 *
 * `types` (optional array of conversation types, e.g. ['SUPPLIER_ADMIN']) scopes
 * the count to only those chatrooms — used by the supplier dashboard's floating
 * "Admin Support" bubble so it never counts unread from channels it doesn't
 * display (e.g. EXPEDITION_CUSTOMER). When `types` is null/empty all
 * conversations are counted (backward compatible — the storefront relies on
 * this).
 */
async function getUnreadCount(userId, types = null) {
  userId = await resolveChatUserId(userId);

  const hasTypes = Array.isArray(types) && types.length > 0;
  const participants = await prisma.conversationParticipant.findMany({
    where: {
      userId,
      ...(hasTypes ? { conversation: { type: { in: types } } } : {}),
    },
    select: {
      conversationId: true,
      lastReadAt: true,
    },
  });

  const counts = await Promise.all(
    participants.map(p =>
      prisma.message.count({
        where: {
          conversationId: p.conversationId,
          createdAt: { gt: p.lastReadAt },
        },
      })
    )
  );

  const total = counts.reduce((sum, c) => sum + c, 0);

  return { unreadCount: total };
}

const EMAIL_ENABLED_TYPES = ['SUPPLIER_CUSTOMER', 'EXPEDITION_CUSTOMER', 'USER_SUPPORT', 'SUPPLIER_ADMIN'];

function chatLinkFor(recipientRoles, conversationId) {
  const q = `?conversation=${encodeURIComponent(conversationId)}`;
  const roles = Array.isArray(recipientRoles) ? recipientRoles : [];
  if (roles.includes('supplier')) return `${emailUrls.supplierDashboard()}/chat${q}`;
  const adminBase = process.env.ADMIN_DASHBOARD_URL || emailUrls.DASHBOARD_URL;
  if (roles.includes('admin') || roles.includes('expedition')) return `${adminBase}/chat${q}`;
  return `${emailUrls.CLIENT_URL}/dashboard/chat${q}`;
}

/**
 * Fire-and-forget: email every participant except the sender about a new
 * message, with a unique reply-to address. Used by both in-app sends and
 * inbound email replies (so the thread loops correctly).
 */
async function notifyConversationByEmail({ conversationId, type, senderId, senderName, content }) {
  if (!EMAIL_ENABLED_TYPES.includes(type)) return;

  const preview = String(content || '').trim().slice(0, 300);
  const participants = await prisma.conversationParticipant.findMany({
    where: { conversationId, userId: { not: senderId } },
    select: { userId: true },
  });
  if (participants.length === 0) return;

  const users = await prisma.user.findMany({
    where: { id: { in: participants.map((p) => p.userId) } },
    select: { id: true, name: true, email: true, roles: true },
  });
  const withEmail = users.filter((u) => typeof u.email === 'string' && u.email.trim());
  if (withEmail.length === 0) return;

  const token = await chatInbound.ensureConversationToken(prisma, conversationId).catch(() => null);
  const replyTo = token ? chatInbound.replyAddressFor(conversationId) : null;

  for (const user of withEmail) {
    enqueueEmail({
      type: 'chat-new-message',
      data: {
        to: user.email,
        recipientName: user.name || '',
        senderName: senderName || 'Someone',
        preview,
        content: preview,
        conversationId,
        replyTo,
        link: chatLinkFor(user.roles, conversationId),
      },
    }).catch((err) => console.error('[ChatService] chat email enqueue failed:', err.message));
  }
}

module.exports = {
  findOrCreateConversation,
  getConversations,
  getMessages,
  sendMessage,
  markAsRead,
  getUnreadCount,
  resolveChatUserId,
  getSharedAdminId,
  getSharedExpeditionId,
  updateMessage,
  deleteMessage,
  hideMessageForMe,
  deleteConversation,
  notifyConversationByEmail,
  EMAIL_ENABLED_TYPES,
};
