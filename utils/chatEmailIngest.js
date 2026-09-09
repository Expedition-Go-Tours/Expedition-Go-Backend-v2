/**
 * Chat inbound email ingestion — webhook independent.
 *
 * A poller lists Resend's received inbox on a cadence and ingests any email
 * not yet processed (deduped by inbound Message-ID). The `email.received`
 * webhook calls the same ingestion path, so delivery is reliable even if the
 * webhook is delayed or dropped.
 *
 * Ingested content: the stripped reply text plus any attachment(s) the sender
 * included — each kept attachment is uploaded to Cloudinary and posted as its
 * own chat message. Other participants get an in-app notification (bell +
 * unread) and a realtime socket event.
 */

const prisma = require('./prismaClient');
const chatService = require('./chatService');
const chatInbound = require('./chatInbound');
const chatAttachments = require('./chatAttachments');
const { sendNotification } = require('./notificationService');
const { notifyAdmin } = require('./adminNotificationService');

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

/** Resolve a signed download URL for one attachment of a received email. */
async function attachmentDownloadUrl(emailId, attachmentId) {
  const res = await fetch(`${RESEND_RECEIVING_API}/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`, {
    headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Attachment meta failed (${res.status})`);
  const body = await res.json().catch(() => null);
  if (!body || typeof body?.download_url !== 'string') throw new Error('No download_url for attachment');
  return body.download_url;
}

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Attachment download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

/** Which of the email's attachments should be forwarded into chat. */
function keepAttachments(email) {
  const html = typeof email?.html === 'string' ? email.html : '';
  const inlineCids = new Set();
  if (html) {
    for (const m of html.matchAll(/cid:([^"'\s>]+)/gi)) inlineCids.add(String(m[1]).toLowerCase());
  }
  const list = Array.isArray(email?.attachments) ? email.attachments : [];
  const kept = [];
  for (const a of list) {
    const contentId = String(a?.content_id || '');
    if (contentId && inlineCids.has(contentId.toLowerCase())) continue; // already embedded in HTML
    const size = Number(a?.size) || 0;
    const contentType = a?.content_type || '';
    if (!chatAttachments.isAllowed(contentType, size)) continue;
    kept.push(a);
    if (kept.length >= chatAttachments.MAX_PER_EMAIL) break;
  }
  return kept;
}

/**
 * Ingest one received email into its conversation. Returns a status string.
 * Idempotent per Message-ID.
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

  const text = chatInbound.extractReplyContent(email);
  const attachments = keepAttachments(email);

  if (!text && attachments.length === 0) return 'ignored';

  const messageId = email?.message_id || null;

  // Dedupe by Message-ID before inserting the batch.
  if (messageId) {
    const existing = await prisma.message.findUnique({ where: { inboundMessageId: messageId } }).catch(() => null);
    if (existing) return 'duplicate';
  }

  // Upload attachments (best effort per file — skip failures, keep the rest).
  const uploaded = [];
  for (const att of attachments) {
    try {
      const url = await attachmentDownloadUrl(emailId, att.id);
      const buf = await fetchBytes(url);
      const secureUrl = await chatAttachments.uploadBuffer(buf, {
        public_id: undefined,
        overwrite: false,
        folder: 'chat/inbound',
      });
      if (secureUrl) uploaded.push({ url: secureUrl, type: chatAttachments.classify(att.content_type) });
    } catch (err) {
      console.error(`[ChatEmailIngest] attachment upload failed (${att.filename}): ${err.message}`);
    }
  }

  // Insert the reply text + each attachment as its own message, atomically.
  let created = [];
  try {
    created = await prisma.$transaction(async (tx) => {
      const out = [];
      let first = true;
      const push = (data) =>
        tx.message.create({
          data: {
            conversationId: conversation.id,
            senderId: author.user.id,
            content: data.content,
            attachmentUrl: data.attachmentUrl || null,
            attachmentType: data.attachmentType || null,
            via: 'email',
            senderEmail,
            inboundMessageId: first ? messageId || undefined : undefined,
          },
          include: {
            sender: { select: { id: true, name: true, photoURL: true, roles: true } },
          },
        }).then((m) => {
          out.push(m);
          first = false;
          return m;
        });

      if (text) await push({ content: text });
      for (const att of uploaded) await push({ content: '', attachmentUrl: att.url, attachmentType: att.type });
      if (out.length === 0) {
        // Nothing to store (shouldn't happen — text/attachments guarded above)
        throw new Error('empty ingest payload');
      }
      return out;
    });
  } catch (err) {
    if (err?.code === 'P2002') return 'duplicate';
    throw err;
  }

  await prisma.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });

  // Realtime: push every inserted message to the room + other participants.
  const io = require('../app').get('io');
  const others = await prisma.conversationParticipant.findMany({
    where: { conversationId: conversation.id, userId: { not: author.user.id } },
    select: { userId: true, user: { select: { id: true, roles: true } } },
  });
  if (io) {
    for (const message of created) {
      io.to(`conversation:${conversation.id}`).emit('chat:message', { conversationId: conversation.id, message });
    }
    for (const o of others) {
      for (const message of created) io.to(`user:${o.userId}`).emit('chat:message', { conversationId: conversation.id, message });
    }
  }

  // In-app notifications (bell + unread) for each other participant.
  const preview = text || (uploaded[0] ? (uploaded[0].type === 'image' ? '📷 Photo' : '📎 File') : '');
  for (const o of others) {
    const result = await sendNotification({
      userId: o.userId,
      type: 'NEW_MESSAGE',
      title: 'New Message',
      message: preview.length > 100 ? `${preview.slice(0, 100)}…` : preview,
      data: { conversationId: conversation.id, senderId: author.user.id, conversationType: conversation.type },
    });
    if (!result?.success) console.error(`[ChatEmailIngest] notification failed for ${o.userId}`);

    // Admin/expedition recipients also ring the platform admin bell.
    const roles = Array.isArray(o.user?.roles) ? o.user.roles : [];
    if (roles.includes('admin') || roles.includes('expedition')) {
      notifyAdmin({
        type: 'NEW_MESSAGE',
        title: `New message from ${author.user.name || 'Email reply'}`,
        message: preview.length > 100 ? `${preview.slice(0, 100)}…` : preview,
        data: { conversationId: conversation.id, senderId: author.user.id, senderName: author.user.name, messageId: created[0]?.id, conversationType: conversation.type },
      }).catch((err) => console.error(`[ChatEmailIngest] admin notify failed: ${err.message}`));
    }
  }

  // Email the other participants so the thread continues.
  if (text || uploaded.length) {
    const firstImage = uploaded.find((a) => a.type === 'image');
    const firstDoc = uploaded.find((a) => a.type === 'document');
    chatService
      .notifyConversationByEmail({
        conversationId: conversation.id,
        type: conversation.type,
        senderId: author.user.id,
        senderName: author.user.name || 'Email reply',
        content: text || (uploaded[0]?.type === 'image' ? '📷 Photo attachment' : '📎 File attachment'),
        attachmentThumbUrl: firstImage?.url || null,
        attachmentDocLabel: firstDoc ? 'Document attachment' : null,
      })
      .catch((err) => console.error(`[ChatEmailIngest] email notify failed: ${err.message}`));
  }

  console.log(`[ChatEmailIngest] inserted ${created.length} message(s) into ${conversation.id}`);
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
