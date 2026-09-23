/**
 * Resend delivery webhook → supplier notification recipients.
 *
 * Resend signs webhooks with Svix. We verify the signature, then use the
 * per-send `notification_recipient` tag to disable exactly the address that
 * hard-bounced or complained — never the supplier's primary (login) email.
 *
 * Events handled: email.bounced, email.complained. Everything else is ignored
 * with a 200 so Resend doesn't retry.
 */

const crypto = require('crypto');
const notificationRecipientService = require('../services/notificationRecipientService');

function lowerHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) out[String(k).toLowerCase()] = v;
  return out;
}

function verifySvix(rawBody, headers, secrets) {
  if (!secrets.length) throw new Error('RESEND_WEBHOOK_SECRET is not configured');
  const id = headers['svix-id'];
  const timestamp = headers['svix-timestamp'];
  const signature = headers['svix-signature'];
  if (!id || !timestamp || !signature) throw new Error('Missing Svix webhook headers');

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 5 * 60) throw new Error('Webhook timestamp out of window');

  // Svix space-separates multiple v1 signatures (secret rotation sends more
  // than one), and either configured Resend secret may have signed the event
  // (dashboard misrouting / rotation). Accept when ANY signature verifies
  // against ANY configured secret — the old first-signature/one-secret check
  // rejected valid events with "Webhook signature mismatch".
  const candidates = String(signature)
    .split(' ')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('v1,'))
    .map((s) => s.slice(3));
  if (!candidates.length) throw new Error('No valid Svix signature present');

  const ok = secrets.some((secret) =>
    candidates.some((supplied) => {
      const expected = crypto
        .createHmac('sha256', secret)
        .update(`${id}.${timestamp}.${rawBody}`)
        .digest('base64');
      const a = Buffer.from(expected);
      const b = Buffer.from(supplied);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    })
  );
  if (!ok) throw new Error('Webhook signature mismatch');
}

// The recipient id rides on the send as a tag so a shared address can't
// disable the wrong supplier's row.
function recipientIdFromTags(event) {
  const tags = event?.data?.tags;
  const list = Array.isArray(tags)
    ? tags
    : (tags && typeof tags === 'object'
        ? Object.entries(tags).map(([name, value]) => ({ name, value }))
        : []);
  const hit = list.find((t) => String(t?.name || '').toLowerCase() === 'notification_recipient');
  return hit?.value ? String(hit.value) : null;
}

function emailFromEvent(event) {
  const to = event?.data?.to;
  if (Array.isArray(to)) return to[0] || null;
  return to || null;
}

async function disableTarget(event, reason) {
  const recipientId = recipientIdFromTags(event);
  if (recipientId) {
    const { count } = await notificationRecipientService.disableById(recipientId, reason);
    return count;
  }
  const email = emailFromEvent(event);
  if (!email) return 0;
  const { count } = await notificationRecipientService.disableByEmail(email, reason);
  return count;
}

exports.receive = async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
  const headers = lowerHeaders(req.headers || {});
  const secrets = [process.env.RESEND_WEBHOOK_SECRET, process.env.RESEND_INBOUND_WEBHOOK_SECRET].filter(Boolean);

  try {
    verifySvix(raw, headers, secrets);
  } catch (err) {
    console.error(`[EmailWebhook] signature rejected: ${err.message}`);
    return res.status(400).json({ status: 'error', message: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return res.status(400).json({ status: 'error', message: 'Invalid JSON' });
  }

  const type = event?.type;
  try {
    if (type === 'email.bounced') {
      const bounce = event?.data?.bounce || {};
      // Only hard bounces disable an address; soft bounces are transient.
      const isHard = !bounce.type || bounce.type === 'hard';
      if (isHard) {
        const count = await disableTarget(event, 'hard_bounce');
        console.log(`[EmailWebhook] hard bounce → disabled ${count} recipient(s)`);
      }
      return res.status(200).json({ status: 'ok' });
    }

    if (type === 'email.complained') {
      const count = await disableTarget(event, 'complaint');
      console.log(`[EmailWebhook] complaint → disabled ${count} recipient(s)`);
      return res.status(200).json({ status: 'ok' });
    }

    if (type === 'email.received') {
      // Diagnostic: received-mail events belong on /api/email/inbound. When
      // they land here the Resend dashboard's inbound webhook URL is wrong —
      // the poller still ingests them, but flag the misroute so it's visible.
      console.warn('[EmailWebhook] email.received arrived at the delivery endpoint — inbound webhook should target /api/email/inbound');
    }

    return res.status(200).json({ status: 'ignored' });
  } catch (err) {
    console.error(`[EmailWebhook] ${type} failed: ${err.message}`);
    // 200 so Resend stops retrying an event we already logged.
    return res.status(200).json({ status: 'error' });
  }
};
