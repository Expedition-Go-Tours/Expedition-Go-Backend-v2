/**
 * Discord notifier — fire-and-forget notifications to topic channels.
 *
 * Safe by design:
 *  - No-op (resolves immediately) when a channel's webhook URL is unset.
 *  - Never throws — all failures are caught and logged.
 *  - Optional per-(channel,key) cooldown so a flood of events cannot spam a channel.
 *
 * Channel -> webhook mapping is driven by env vars (see .env.example):
 *   deploys, incidents, sales, verification, digest, approvals
 */

const WEBHOOKS = {
  deploys: process.env.DISCORD_WEBHOOK_DEPLOYS,
  incidents: process.env.DISCORD_WEBHOOK_INCIDENTS,
  sales: process.env.DISCORD_WEBHOOK_SALES,
  verification: process.env.DISCORD_WEBHOOK_VERIFICATION,
  digest: process.env.DISCORD_WEBHOOK_DIGEST,
  approvals: process.env.DISCORD_WEBHOOK_APPROVALS,
};

// No cooldown by default so every meaningful event notifies. Callers that
// expect high-frequency/less-important events can pass cooldownMs.
const DEFAULT_COOLDOWN_MS = 0;

const cooldowns = new Map();

function inCooldown(key, ms) {
  if (ms <= 0) return false;
  const now = Date.now();
  const until = cooldowns.get(key) || 0;
  if (now < until) return true;
  cooldowns.set(key, now + ms);
  if (cooldowns.size > 500) cooldowns.clear();
  return false;
}

async function post(url, payload) {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    try {
      console.error(`[discordNotifier] send failed to ${String(url).slice(0, 48)}...: ${err.message}`);
    } catch {
      // no-op — logging must never throw
    }
  }
}

/**
 * Send a notification to a topic channel.
 *
 * @param {'deploys'|'incidents'|'sales'|'verification'|'digest'|'approvals'} channel
 * @param {string} content plain-text message body
 * @param {{cooldownMs?: number, cooldownKey?: string, title?: string, fields?: Array<{name: string; value: string; inline?: boolean}>, color?: number}} [opts]
 * @returns {Promise<void>} always resolves; never rejects
 */
function notifyDiscord(channel, content, opts = {}) {
  const url = WEBHOOKS[channel];
  if (!url || typeof content !== 'string' || !content.trim()) return Promise.resolve();

  const cooldownMs = Number(opts.cooldownMs) || DEFAULT_COOLDOWN_MS;
  const key = `discord:${channel}:${opts.cooldownKey || 'default'}`;
  if (inCooldown(key, cooldownMs)) return Promise.resolve();

  const payload = {};
  if (opts.title || (opts.fields && opts.fields.length)) {
    payload.embeds = [
      {
        title: opts.title || 'TravioAfrica',
        description: content,
        color: opts.color || 0x5865f2,
        fields: opts.fields || [],
      },
    ];
  } else {
    payload.content = content;
  }
  return post(url, payload);
}

module.exports = { notifyDiscord, WEBHOOKS };
