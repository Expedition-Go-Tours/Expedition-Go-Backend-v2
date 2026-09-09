/**
 * Chat inbound email ingestion — webhook independent.
 *
 * A poller lists Resend's received inbox on a cadence and ingests any email
 * not yet processed (deduped by inbound Message-ID). The `email.received`
 * webhook calls the same ingestion path, so delivery is reliable even if the
 * webhook is delayed or dropped.
 */

const prisma = require('./prismaClient');
const chatService = require('./chatService');
const chatInbound = require('./chatInbound');
const { enqueueNotification } = require('./queue');

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_RECEIVING_API = 'https://api.resend.com/emails/receiving';

async function resendGet(path) {
  const res = await fetch(`${RESEND_RECEIVING_API}${path}`, {
    headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Resend receiving API failed (${res.status})`);
  return res.json();
}

async function fetchReceivedEmail(emailId) {
  const res = await fetch(`${RESEND_RECEIVING_API}/${encodeURIComponent(emailId)}`, {
    headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Resend received-email fetch failed (${res.status})`);
  return res.json();
}

/**
 * Ingest one received email into its conversation. Returns a status string so
 * callers/webhooks can respond appropriately. Idempotent per Message-ID.
 */
async function ingestReceivedEmail(emailId) {
  if (!emailId) return 'ignored';

  let email;
  try {
    email = await fetchReceivedEmail(emailId);
  } catch (err) {
    console.error(`[ChatEmailIngest] fetch failed ${emailId}: ${err.message}`);
    return 'fetch_failed';
  }

  const toList = Array.isArray(email?.to) ? email.to : [];
  const tokens = chatInbound.tokensFromRecipients(toList);
  let conversation = null;
  for (const t of tokens) {
    conversation = await prisma.conversation.findFirst({ where: { replyToken: t.token } });
    if (conversation) break;
  }
  if (!conversation || !chatService.EMAIL_ENABLED_TYPES.includes(conversation.type)) {
    console.log(`[ChatEmailIngest] no matching conversation for ${emailId} — ignoring`);
    return 'ignored';
  }

  const senderEmail = chatInbound.parseEmail(email?.from || '');
  if (!senderEmail) return 'ignored';

  const author = await prisma.conversationParticipant.findFirst({
    where: {
      conversationId: conversation.id,
      user: { email: { equals: senderEmail, mode: 'insensitive' } },
    },
    include: { user: { select: { id: true, name: true, email: true, photoURL: true, roles: true } } },
  });
  if (!author) {
    console.log(`[ChatEmailIngest] sender ${senderEmail} is not a participant — ignoring`);
    return 'ignored';
  }

  const textPart = typeof email?.text === 'string' ? email.text : '';
  const htmlPart = typeof email?.html === 'string' ? email.html : '';
  const content = chatInbound.stripReplyText(textPart || chatInbound.htmlToText(htmlPart));
  if (!content) return 'ignored';

  const messageId = email?.message_id || null;

  let message;
  try {
    message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderId: author.user.id,
        content,
        via: 'email',
        senderEmail,
        inboundMessageId: messageId || undefined,
      },
      include: {
        sender: { select: { id: true, name: true, photoURL: true, roles: true } },
      },
    });
  } catch (err) {
    if (err?.code === 'P2002') return 'duplicate';
    throw err;
  }

  await prisma.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });

  const io = require('../app').get('io');
  const payload = { conversationId: conversation.id, message };
  if (io) io.to(`conversation:${conversation.id}`).emit('chat:message', payload);
  const others = await prisma.conversationParticipant.findMany({
    where: { conversationId: conversation.id, userId: { not: author.user.id } },
    select: { userId: true },
  });
  if (io) for (const o of others) io.to(`user:${o.userId}`).emit('chat:message', payload);

  for (const o of others) {
    enqueueNotification({
      userId: o.userId,
      type: 'NEW_MESSAGE',
      title: 'New Message',
      message: content.length > 100 ? `${content.slice(0, 100)}…` : content,
      data: { conversationId: conversation.id, senderId: author.user.id, conversationType: conversation.type },
    }).catch(() => {});
  }

  chatService
    .notifyConversationByEmail({
      conversationId: conversation.id,
      type: conversation.type,
      senderId: author.user.id,
      senderName: author.user.name || 'Email reply',
      content,
    })
    .catch(() => {});

  console.log(`[ChatEmailIngest] inserted ${message.id} (via email) into ${conversation.id}`);
  return 'success';
}

/**
 * Poll Resend's received inbox for messages we have not ingested yet.
 * Runs in-process on an interval (deduped by inbound Message-ID).
 */
async function pollReceivedEmails() {
  let list;
  try {
    list = await resendGet('?limit=20');
  } catch (err) {
    console.error(`[ChatEmailIngest] poll list failed: ${err.message}`);
    return;
  }
  const items = Array.isArray(list?.data) ? list.data : [];
  if (items.length === 0) return;

  for (const item of items) {
    const mid = item?.message_id;
    if (!mid) continue;
    const existing = await prisma.message.findUnique({ where: { inboundMessageId: mid } }).catch(() => null);
    if (existing) continue;
    try {
      await ingestReceivedEmail(item.id);
    } catch (err) {
      console.error(`[ChatEmailIngest] ingest ${item.id} failed: ${err.message}`);
    }
  }
}

module.exports = { ingestReceivedEmail, pollReceivedEmails, fetchReceivedEmail };
