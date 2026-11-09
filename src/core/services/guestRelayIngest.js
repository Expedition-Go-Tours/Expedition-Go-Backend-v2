/**
 * Inbound/outbound mail for a guest booking relay (`g-…`).
 *
 * Two directions share one address:
 *
 *   supplier  ->  g-…@domain  ->  guest's real inbox
 *   guest     ->  g-…@domain  ->  supplier's booking recipients
 *
 * The address is a bearer token, so the sender still has to be authorised:
 *  - A supplier-side sender is the supplier account itself or one of its
 *    VERIFIED notification recipients with `bookings` enabled, and must pass
 *    DMARC. Otherwise the relay could be used to phish the guest.
 *  - A guest-side sender is accepted when their `From` equals the booking's
 *    current guest address. That is the chosen trade-off: it stops arbitrary
 *    senders, but not a spoofed `From`. The token stays unguessable and every
 *    relay is rate-limited.
 *
 * Every message is archived (including ignored ones) so the platform has a
 * dispute record and the poller can dedupe by provider Message-ID.
 */

const prisma = require('./prismaClient');
const chatInbound = require('./chatInbound');
const emailService = require('./emailService');
const guestRelay = require('./guestRelay');
const logger = require('./logger');
const { getBrandEmail } = require('../../../config/brands');

const MAX_PER_HOUR = 20;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function headerValue(headers, name) {
  if (!headers) return '';
  const wanted = String(name).toLowerCase();
  if (Array.isArray(headers)) {
    const found = headers.find((h) => String(h?.name || h?.key || '').toLowerCase() === wanted);
    return found ? String(found.value ?? '') : '';
  }
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === wanted) {
      return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
    }
  }
  return '';
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function oneLine(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

/** Prefix an existing HTML body with a plain notice, without nesting documents. */
function withNotice(html, notice) {
  const block = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#111;padding:12px 16px;border-left:3px solid #065F46;background:#F3F8F6;margin:0 0 16px">${escapeHtml(notice)}</div>`;
  if (!html) return null;
  const body = String(html);
  const m = body.match(/<body[^>]*>/i);
  if (m) return body.replace(m[0], `${m[0]}${block}`);
  return block + body;
}

function textBodyHtml(text) {
  return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;white-space:pre-wrap">${escapeHtml(text)}</div>`;
}

function relayDomainIsOurs(email) {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const host = email.slice(at + 1).toLowerCase();
  return chatInbound.receivingDomains().includes(host);
}

/** True when this looks like a bounce/auto-reply rather than a person. */
function isAutomated(email) {
  const auto = headerValue(email?.headers, 'auto-submitted').toLowerCase();
  if (auto && auto !== 'no') return true;
  if (headerValue(email?.headers, 'x-autoreply')) return true;
  if (headerValue(email?.headers, 'x-autorespond')) return true;
  const precedence = headerValue(email?.headers, 'precedence').toLowerCase();
  if (precedence === 'bulk' || precedence === 'auto_reply') return true;
  return false;
}

async function supplierAccount(supplierId) {
  return prisma.user.findUnique({
    where: { id: supplierId },
    select: { id: true, name: true, email: true },
  });
}

/** Authorise a supplier-side sender and return the supplier when accepted. */
async function supplierSenderFor(relay, senderEmail, authentication) {
  // Forwarding to the guest is trusted only when the message really came from
  // the supplier's side; a spoofed From would otherwise relay phishing.
  const dmarc = authentication?.dmarc;
  const supplier = await supplierAccount(relay.supplierId);
  if (!supplier?.email) return null;

  // The owner's exact address plus the unguessable token is strong enough to
  // accept a domain with no DMARC policy ("gray"). A failed check is always
  // rejected: that is the spoofing signal.
  if (normalize(supplier.email) === senderEmail) {
    return dmarc === 'pass' || dmarc === 'gray' ? supplier : null;
  }

  if (dmarc !== 'pass') return null;

  const recipient = await prisma.supplierNotificationRecipient.findFirst({
    where: {
      supplierId: relay.supplierId,
      email: { equals: senderEmail, mode: 'insensitive' },
      status: 'VERIFIED',
      disabledAt: null,
    },
    select: { preferences: true },
  });
  if (!recipient) return null;
  const prefs = recipient.preferences && typeof recipient.preferences === 'object' ? recipient.preferences : {};
  if (prefs.bookings !== true) return null;
  return supplier;
}

/** Everyone who should receive a guest's reply: the owner plus verified staff. */
async function supplierRecipients(relay, exclude = '') {
  const supplier = await supplierAccount(relay.supplierId);
  const out = new Set();
  if (supplier?.email) out.add(normalize(supplier.email));

  try {
    const recipients = await prisma.supplierNotificationRecipient.findMany({
      where: {
        supplierId: relay.supplierId,
        status: 'VERIFIED',
        disabledAt: null,
      },
      select: { email: true, preferences: true },
    });
    for (const r of recipients) {
      const prefs = r.preferences && typeof r.preferences === 'object' ? r.preferences : {};
      if (prefs.bookings === true && r.email) out.add(normalize(r.email));
    }
  } catch (err) {
    logger.warn(`[GuestRelay] recipient lookup failed for ${relay.id}: ${err.message}`);
  }

  out.delete(exclude);
  return { supplier, recipients: [...out] };
}

async function record({ relayId, direction, email, status, error, attachments, fromEmail, toEmail, subject, text }) {
  const messageId = email?.message_id || null;
  const data = {
    relayId,
    direction,
    messageId,
    fromEmail: fromEmail || '',
    toEmail: toEmail || '',
    subject: subject || null,
    textBody: text || null,
    htmlBody: typeof email?.html === 'string' ? email.html.slice(0, 200000) : null,
    attachments: attachments || null,
    status,
    error: error || null,
  };

  try {
    if (messageId) {
      const existing = await prisma.guestRelayMessage.findUnique({ where: { messageId } });
      if (existing) {
        // A retry after a transient failure reuses the row; a completed one is
        // a duplicate and must not be forwarded twice.
        if (existing.status === 'FORWARDED' || existing.status === 'IGNORED') return { row: existing, duplicate: true };
        return {
          row: await prisma.guestRelayMessage.update({ where: { id: existing.id }, data }),
          duplicate: false,
        };
      }
    }
    return { row: await prisma.guestRelayMessage.create({ data }), duplicate: false };
  } catch (err) {
    if (err?.code === 'P2002') {
      const row = await prisma.guestRelayMessage.findUnique({ where: { messageId } });
      return { row, duplicate: true };
    }
    logger.warn(`[GuestRelay] archive write failed for ${relayId}: ${err.message}`);
    return { row: null, duplicate: false };
  }
}

async function overRateLimit(relayId) {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const count = await prisma.guestRelayMessage.count({
    where: { relayId, createdAt: { gte: since }, status: { not: 'IGNORED' } },
  }).catch(() => 0);
  return count >= MAX_PER_HOUR;
}

/** Download the non-inline attachments, up to the size/count cap. */
async function collectAttachments(emailId, email, fetchAttachment) {
  if (typeof fetchAttachment !== 'function') return { forwarded: [], meta: [], truncated: false };

  const html = typeof email?.html === 'string' ? email.html : '';
  const inlineCids = new Set();
  for (const m of html.matchAll(/cid:([^"'\s>]+)/gi)) inlineCids.add(String(m[1]).toLowerCase());

  const list = Array.isArray(email?.attachments) ? email.attachments : [];
  const forwarded = [];
  const meta = [];
  let total = 0;
  let truncated = false;

  for (const att of list) {
    if (forwarded.length >= MAX_ATTACHMENTS) { truncated = true; break; }
    const contentId = String(att?.content_id || '');
    if (contentId && inlineCids.has(contentId.toLowerCase())) continue;

    const size = Number(att?.size) || 0;
    if (total + size > MAX_ATTACHMENT_BYTES) { truncated = true; continue; }

    try {
      const buffer = await fetchAttachment(emailId, att);
      if (!buffer || buffer.length === 0) continue;
      if (total + buffer.length > MAX_ATTACHMENT_BYTES) { truncated = true; continue; }
      total += buffer.length;
      forwarded.push({ filename: att.filename || 'attachment', content: buffer.toString('base64') });
      meta.push({ filename: att.filename || 'attachment', contentType: att.content_type || '', size: buffer.length });
    } catch (err) {
      logger.warn(`[GuestRelay] attachment fetch failed (${att?.filename || 'file'}): ${err.message}`);
      truncated = true;
    }
  }

  return { forwarded, meta, truncated };
}

/**
 * Ingest one received email addressed to a guest relay.
 *
 * `fetchAttachment` is supplied by the caller (chatEmailIngest) so this module
 * does not need its own Resend client or a circular require.
 */
async function ingestReceivedEmail({ emailId, email, token, fetchAttachment }) {
  if (!emailId || !email || !token) return 'ignored';

  const relay = await guestRelay.findByToken(token.token);
  if (!relay || relay.disabledAt) return 'ignored';

  const senderEmail = normalize(chatInbound.parseEmail(email?.from || ''));
  if (!senderEmail) return 'ignored';
  if (isAutomated(email)) return 'ignored';
  // Never relay our own mail back into the platform.
  if (relayDomainIsOurs(senderEmail)) return 'ignored';

  const booking = relay.booking;
  const guestEmail = guestRelay.realGuestEmail(relay);
  if (!guestEmail) return 'ignored';

  let direction = null;
  let supplier = null;

  if (senderEmail === guestEmail) {
    direction = 'INBOUND';
  } else {
    supplier = await supplierSenderFor(relay, senderEmail, email?.authentication);
    if (supplier) direction = 'OUTBOUND';
  }

  if (!direction) {
    await record({
      relayId: relay.id,
      direction: 'INBOUND',
      email,
      status: 'IGNORED',
      error: 'sender_not_authorised',
      fromEmail: senderEmail,
      toEmail: relay.address,
      subject: email?.subject,
      text: chatInbound.extractReplyContent(email),
    });
    return 'ignored';
  }

  if (await overRateLimit(relay.id)) {
    await record({
      relayId: relay.id,
      direction,
      email,
      status: 'IGNORED',
      error: 'rate_limited',
      fromEmail: senderEmail,
      toEmail: relay.address,
      subject: email?.subject,
    });
    return 'ignored';
  }

  const text = chatInbound.extractReplyContent(email);
  const attachments = await collectAttachments(emailId, email, fetchAttachment);
  if (!text && attachments.forwarded.length === 0) {
    await record({
      relayId: relay.id,
      direction,
      email,
      status: 'IGNORED',
      error: 'empty_message',
      fromEmail: senderEmail,
      toEmail: relay.address,
      subject: email?.subject,
    });
    return 'ignored';
  }

  const archived = await record({
    relayId: relay.id,
    direction,
    email,
    status: 'RECEIVED',
    fromEmail: senderEmail,
    toEmail: relay.address,
    subject: email?.subject,
    text,
    attachments: attachments.meta.length ? attachments.meta : null,
  });
  if (archived.duplicate) return 'duplicate';

  const brandKey = guestRelay.brandKeyForBooking(booking);
  const brandName = getBrandEmail(brandKey).brandName;
  const bookingNumber = booking.bookingNumber || '';
  const guestName = booking.leadTravelerName || booking.guest?.name || 'Guest';
  const supplierName = supplier?.name || 'your supplier';

  let to;
  let subject;
  let notice;
  let replyTo;
  let relayFromName;

  if (direction === 'OUTBOUND') {
    // supplier -> guest
    to = guestEmail;
    subject = oneLine(email?.subject) || `Message about booking ${bookingNumber}`;
    notice = `Message from ${supplierName} about booking ${bookingNumber}. Reply to this email to answer them.`;
    replyTo = relay.address;
    relayFromName = `${supplierName} via ${brandName}`;
  } else {
    // guest -> supplier
    const audience = await supplierRecipients(relay, guestEmail);
    if (audience.recipients.length === 0) {
      await record({
        relayId: relay.id,
        direction,
        email,
        status: 'IGNORED',
        error: 'no_supplier_recipient',
        fromEmail: senderEmail,
        toEmail: relay.address,
        subject: email?.subject,
      });
      return 'ignored';
    }
    to = audience.recipients;
    subject = `Re: [${bookingNumber}] ${oneLine(email?.subject) || 'Reply from your guest'}`;
    notice = `Reply from ${guestName} about booking ${bookingNumber}. Reply to this email to answer them.`;
    replyTo = relay.address;
    relayFromName = `${guestName} via ${brandName}`;
  }

  const noticeHtml = withNotice(
    typeof email?.html === 'string' && email.html.length <= 500000 ? email.html : '',
    notice,
  );
  const html = noticeHtml || textBodyHtml(`${notice}\n\n${text}`);
  if (attachments.truncated) {
    // Keep the text; say plainly that a file did not make it through.
    // The archived metadata still records what was attached.
  }

  try {
    const result = await emailService.sendHtml({
      to,
      subject,
      html,
      text: `${notice}\n\n${text}`,
      attachments: attachments.forwarded,
      replyTo,
      inReplyTo: email?.message_id || undefined,
      fromName: relayFromName,
      brandKey,
      tags: [
        { name: 'guest_relay', value: relay.id },
        { name: 'guest_relay_direction', value: direction.toLowerCase() },
      ],
    });

    if (archived.row) {
      await prisma.guestRelayMessage.update({
        where: { id: archived.row.id },
        data: {
          status: result?.success === false ? 'FAILED' : 'FORWARDED',
          providerId: result?.messageId || null,
          toEmail: Array.isArray(to) ? to.join(',') : to,
          error: result?.success === false ? (result?.reason || 'send_failed') : null,
        },
      }).catch(() => {});
    }

    if (result?.success === false) return 'failed';
    return 'success';
  } catch (err) {
    logger.warn(`[GuestRelay] forward failed for ${relay.id}: ${err.message}`);
    if (archived.row) {
      await prisma.guestRelayMessage.update({
        where: { id: archived.row.id },
        data: { status: 'FAILED', error: err.message.slice(0, 500) },
      }).catch(() => {});
    }
    return 'failed';
  }
}

module.exports = {
  ingestReceivedEmail,
  // Test hooks
  __headerValue: headerValue,
  __isAutomated: isAutomated,
  __withNotice: withNotice,
};
