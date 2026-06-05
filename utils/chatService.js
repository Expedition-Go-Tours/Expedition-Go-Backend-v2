const prisma = require('./prismaClient');
const { enqueueNotification } = require('./queue');
const { notifyAdmin } = require('./adminNotificationService');

let _sharedAdminId = null;

async function getSharedAdminId() {
  if (!_sharedAdminId) {
    const admin = await prisma.user.findFirst({
      where: { roles: { has: 'admin' } },
      orderBy: { createdAt: 'asc' },
      select: { id: true }
    });
    _sharedAdminId = admin?.id || null;
  }
  return _sharedAdminId;
}

async function resolveChatUserId(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { roles: true }
  });
  if (user?.roles?.includes('admin')) {
    const sharedId = await getSharedAdminId();
    return sharedId || userId;
  }
  return userId;
}

async function findOrCreateConversation(senderId, recipientId, type = 'SUPPLIER_ADMIN') {
  senderId = await resolveChatUserId(senderId);
  recipientId = await resolveChatUserId(recipientId);

  const existing = await prisma.conversation.findFirst({
    where: {
      type,
      participants: {
        every: {
          userId: { in: [senderId, recipientId] }
        }
      },
      AND: [
        { participants: { some: { userId: senderId } } },
        { participants: { some: { userId: recipientId } } },
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

  if (existing) return existing;

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

  return participants.map(p => {
    const lastMessage = p.conversation.messages[0];
    const hasUnread = lastMessage && lastMessage.createdAt > p.lastReadAt;
    return {
      ...p.conversation,
      unreadCount: hasUnread ? 1 : 0,
      lastReadAt: p.lastReadAt,
      _participant: { id: p.id, lastReadAt: p.lastReadAt },
    };
  });
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
    where,
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

  if (!participant) throw Object.assign(new Error('Conversation not found'), { statusCode: 404 });

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
      data: { conversationId, senderId }
    }).catch(() => {});
  }

  const sender = await prisma.user.findUnique({
    where: { id: originalSenderId },
    select: { roles: true, name: true }
  });

  const chatType = participant.conversation.type === 'SUPPLIER_ADMIN' ? 'suppliers' : 'customers';

  if (sender && sender.roles.includes('supplier')) {
    notifyAdmin({
      type: 'NEW_MESSAGE',
      title: `New message from ${sender.name}`,
      message: content.length > 100 ? content.slice(0, 100) + '...' : content,
      data: { conversationId, senderId, senderName: sender.name, messageId: message.id, chatType }
    });
  }

  return message;
}

async function markAsRead(conversationId, userId) {
  userId = await resolveChatUserId(userId);

  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } }
  });

  if (!participant) throw Object.assign(new Error('Conversation not found'), { statusCode: 404 });

  await prisma.conversationParticipant.update({
    where: { id: participant.id },
    data: { lastReadAt: new Date() }
  });

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

  await prisma.message.delete({ where: { id: messageId } });
}

async function deleteConversation(conversationId, userId) {
  const resolvedUserId = await resolveChatUserId(userId);

  const participant = await prisma.conversationParticipant.findFirst({
    where: { conversationId, userId: resolvedUserId },
  });

  if (!participant) throw Object.assign(new Error('Conversation not found'), { statusCode: 404 });

  await prisma.conversation.delete({ where: { id: conversationId } });
}

async function getUnreadCount(userId) {
  userId = await resolveChatUserId(userId);

  const participants = await prisma.conversationParticipant.findMany({
    where: { userId },
    include: {
      conversation: {
        select: {
          id: true,
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { createdAt: true }
          }
        }
      }
    }
  });

  let total = 0;
  for (const p of participants) {
    const lastMessage = p.conversation.messages[0];
    if (lastMessage && lastMessage.createdAt > p.lastReadAt) {
      total++;
    }
  }

  return { unreadCount: total };
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
  updateMessage,
  deleteMessage,
  deleteConversation,
};
