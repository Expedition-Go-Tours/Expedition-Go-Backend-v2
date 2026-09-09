/**
 * Reply-by-email helpers for chat.
 *
 * Outbound notifications carry a unique Reply-To address of the form
 *   c-<16-hex-hmac>@<receiving-domain>
 * where the HMAC is over the conversation id. Inbound mail is routed back by
 * looking up the conversation by its stored `replyToken` and authenticating the
 * sender as one of the participants.
 */

const crypto = require('crypto');

const RECEIVING_DOMAIN = (process.env.RESEND_RECEIVING_DOMAIN || 'messages.travioafrica.com').replace(/^@/, '');
const SECRET = process.env.RESEND_INBOUND_WEBHOOK_SECRET || '';

function tokenFor(conversationId) {
  return `c${crypto
    .createHmac('sha256', SECRET || 'insecure-dev')
    .update(String(conversationId))
    .digest('hex')
    .slice(0, 16)}`;
}

/** Ensure the conversation has a stable reply token and return it. */
async function ensureConversationToken(prisma, conversationId) {
  const row = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, replyToken: true },
  });
  if (!row) throw new Error(`Conversation ${conversationId} not found`);
  if (row.replyToken) return row.replyToken;
  const token = tokenFor(row.id);
  await prisma.conversation.update({ where: { id: row.id }, data: { replyToken: token } });
  return token;
}

function replyAddressFor(conversationId) {
  return `c-${tokenFor(conversationId).slice(1)}@${RECEIVING_DOMAIN}`;
}

/** Parse local/domain from an email header value that may include a display name. */
function parseEmail(value) {
  const raw = String(value || '').trim();
  const m = raw.match(/<([^<>]+)>/) || raw.match(/([^\s@]+@[^\s@]+)/);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Extract inbound tokens from a list of `to` addresses.
 * Returns [{ token, local, domain }] for addresses matching c-<hex>@domain.
 */
function tokensFromRecipients(toList, domain = RECEIVING_DOMAIN) {
  const list = Array.isArray(toList) ? toList : [];
  const out = [];
  for (const value of list) {
    const email = parseEmail(value);
    const at = email.lastIndexOf('@');
    if (at < 0) continue;
    const local = email.slice(0, at);
    const host = email.slice(at + 1);
    if (host !== domain.toLowerCase()) continue;
    const m = local.match(/^c-([0-9a-f]{16})$/i);
    if (m) out.push({ token: local, hex: m[1].toLowerCase() });
  }
  return out;
}

/**
 * Svix-style webhook verification (Resend uses Svix headers).
 * Throws when the signature is invalid/expired.
 */
function verifyWebhookSignature(rawBody, headers) {
  if (!SECRET) throw new Error('RESEND_INBOUND_WEBHOOK_SECRET is not configured');
  const id = headers['svix-id'] || headers['Svix-Id'];
  const timestamp = headers['svix-timestamp'] || headers['Svix-Timestamp'];
  const signatureHeader = headers['svix-signature'] || headers['Svix-Signature'];
  if (!id || !timestamp || !signatureHeader) throw new Error('Missing Svix webhook headers');

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 5 * 60) throw new Error('Webhook timestamp out of window');

  const expected = crypto
    .createHmac('sha256', SECRET)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest('base64');

  const supplied = String(signatureHeader)
    .split(' ')
    .map((s) => s.trim())
    .find((s) => s.startsWith('v1,'))
    ?.split(',')[1];

  if (!supplied) throw new Error('No valid Svix signature present');
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Webhook signature mismatch');
}

/** Strip quoted reply history + signatures from plaintext so only the new text stays. */
function stripReplyText(text) {
  if (!text) return '';
  const lines = String(text).replace(/\r/g, '').split('\n');
  const out = [];
  let quoted = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^>/.test(line) || /^On .+wrote:$/i.test(line) || /^--\s*$/.test(trimmed)) {
      quoted = true;
      continue;
    }
    if (!quoted) out.push(line);
    // Quoted block ends when a non-empty, non-quoted line appears after one.
    if (quoted && trimmed !== '') {
      // Resend/email clients put the reply first; keep new content already seen.
    }
  }
  const joined = out.join('\n').trim().slice(0, 4000);
  return joined;
}

/** Very small HTML -> text fallback so replies without a plain part still land. */
function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

module.exports = {
  RECEIVING_DOMAIN,
  tokenFor,
  ensureConversationToken,
  replyAddressFor,
  parseEmail,
  tokensFromRecipients,
  verifyWebhookSignature,
  stripReplyText,
  htmlToText,
};
