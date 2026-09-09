/**
 * Resend `email.received` webhook → chat message.
 *
 * Routing + security:
 *  - Svix-signed payload (id/timestamp/signature headers) verified against
 *    RESEND_INBOUND_WEBHOOK_SECRET.
 *  - Full body/headers fetched from Resend's Received-emails API.
 *  - The unique `to` address (c-<hmac>@messages.…) resolves the conversation.
 *  - Only a participant whose account email matches the From address can post.
 *  - Replies are deduped by Message-ID.
 *
 * On success the message is inserted (via=email), pushed to the conversation
 * room, an in-app notification is enqueued for the other participant(s), and
 * they are emailed so the thread continues.
 */

const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const chatService = require('../utils/chatService');
const chatInbound = require('../utils/chatInbound');
const { enqueueNotification } = require('../utils/queue');
const logger = require('../utils/logger');

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';

async function fetchReceivedEmail(emailId) {
  const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
    headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Resend received-email fetch failed (${res.status})`);
  return res.json();
}

function lowerHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) out[String(k).toLowerCase()] = v;
  return out;
}

exports.receive = catchAsync(async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
  const headers = lowerHeaders(req.headers || {});

  // 1) Verify the Svix signature so only Resend can post here.
  try {
    chatInbound.verifyWebhookSignature(raw, headers);
  } catch (err) {
    logger.warn(`[emailInbound] signature rejected: ${err.message}`);
    return res.status(400).json({ status: 'error', message: 'Invalid signature' });
  }

  // 2) Parse the event.
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return res.status(400).json({ status: 'error', message: 'Invalid JSON' });
  }
  if (event?.type !== 'email.received') {
    return res.status(200).json({ status: 'ignored' });
  }

  const meta = event?.data || {};
  const emailId = meta?.email_id;
  if (!emailId) return res.status(200).json({ status: 'ignored' });

  // 3) Fetch the full email body/headers.
  let email;
  try {
    email = await fetchReceivedEmail(emailId);
  } catch (err) {
    logger.error(`[emailInbound] failed to fetch received email ${emailId}: ${err.message}`);
    return res.status(200).json({ status: 'ignored' }); // webhook may retry
  }

  // 4) Resolve the conversation from the unique reply address.
  const toList = Array.isArray(email?.to) ? email.to : [];
  const tokens = chatInbound.tokensFromRecipients(toList);
  let conversation = null;
  for (const t of tokens) {
    conversation = await prisma.conversation.findFirst({ where: { replyToken: t.token } });
    if (conversation) break;
  }
  if (!conversation || !chatService.EMAIL_ENABLED_TYPES.includes(conversation.type)) {
    logger.info('[emailInbound] no matching conversation for reply address — dropping');
    return res.status(200).json({ status: 'ignored' });
  }

  // 5) The sender must be one of the conversation's participants.
  const senderEmail = chatInbound.parseEmail(email?.from || meta?.from || '');
  if (!senderEmail) {
    logger.info('[emailInbound] missing From address — dropping');
    return res.status(200).json({ status: 'ignored' });
  }
  const author = await prisma.conversationParticipant.findFirst({
    where: { conversationId: conversation.id, user: { email: { equals: senderEmail, mode: 'insensitive' } } },
    include: { user: { select: { id: true, name: true, email: true, photoURL: true, roles: true } } },
  });
  if (!author) {
    logger.info(`[emailInbound] sender ${senderEmail} is not a participant — dropping`);
    return res.status(200).json({ status: 'ignored' });
  }

  // 6) Content (text preferred, strip quoted history/signatures).
  const textPart = typeof email?.text === 'string' ? email.text : '';
  const htmlPart = typeof email?.html === 'string' ? email.html : '';
  const content = chatInbound.stripReplyText(textPart || chatInbound.htmlToText(htmlPart));
  if (!content) {
    logger.info('[emailInbound] empty reply body — dropping');
    return res.status(200).json({ status: 'ignored' });
  }

  const messageId = email?.message_id || meta?.message_id || null;

  // 7) Insert (dedupe by Message-ID).
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
    if (err?.code === 'P2002') return res.status(200).json({ status: 'duplicate' });
    throw err;
  }

  await prisma.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });

  // 8) Broadcast to the conversation room + other participant's user room.
  const io = require('../app').get('io');
  const payload = { conversationId: conversation.id, message };
  if (io) io.to(`conversation:${conversation.id}`).emit('chat:message', payload);
  const others = await prisma.conversationParticipant.findMany({
    where: { conversationId: conversation.id, userId: { not: author.user.id } },
    select: { userId: true },
  });
  if (io) {
    for (const o of others) io.to(`user:${o.userId}`).emit('chat:message', payload);
  }

  // 9) In-app notifications + email to the other participants.
  for (const o of others) {
    enqueueNotification({
      userId: o.userId,
      type: 'NEW_MESSAGE',
      title: 'New Message',
      message: content.length > 100 ? `${content.slice(0, 100)}…` : content,
      data: { conversationId: conversation.id, senderId: author.user.id, conversationType: conversation.type },
    }).catch((err) => logger.error(`[emailInbound] notification failed: ${err.message}`));
  }

  chatService
    .notifyConversationByEmail({
      conversationId: conversation.id,
      type: conversation.type,
      senderId: author.user.id,
      senderName: author.user.name || 'Email reply',
      content,
    })
    .catch((err) => logger.error(`[emailInbound] email notify failed: ${err.message}`));

  return res.status(200).json({ status: 'success', data: { messageId: message.id } });
});
