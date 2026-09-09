/**
 * Resend `email.received` webhook → chat message.
 *
 * The webhook verifies the Svix signature, then delegates content fetching and
 * conversation ingestion to utils/chatEmailIngest (also used by the inbox
 * poller, so delivery doesn't depend solely on webhooks).
 */

const chatInbound = require('../utils/chatInbound');
const { ingestReceivedEmail } = require('../utils/chatEmailIngest');

function lowerHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) out[String(k).toLowerCase()] = v;
  return out;
}

exports.receive = async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
  const headers = lowerHeaders(req.headers || {});

  try {
    chatInbound.verifyWebhookSignature(raw, headers);
  } catch (err) {
    console.error(`[EmailInbound] signature rejected: ${err.message}`);
    return res.status(400).json({ status: 'error', message: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return res.status(400).json({ status: 'error', message: 'Invalid JSON' });
  }
  if (event?.type !== 'email.received') return res.status(200).json({ status: 'ignored' });

  const emailId = event?.data?.email_id;
  if (!emailId) return res.status(200).json({ status: 'ignored' });

  try {
    const status = await ingestReceivedEmail(emailId);
    return res.status(200).json({ status });
  } catch (err) {
    console.error(`[EmailInbound] ingest ${emailId} failed: ${err.message}`);
    // 200 so Resend stops retrying a message we already captured via polling.
    return res.status(200).json({ status: 'error' });
  }
};
