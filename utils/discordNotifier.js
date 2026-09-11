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
 *
 * For interactive notifications (buttons), use sendViaBot() which sends via
 * the bot token so Discord associates interactive components with the app.
 */

const WEBHOOKS = {
  deploys: process.env.DISCORD_WEBHOOK_DEPLOYS,
  incidents: process.env.DISCORD_WEBHOOK_INCIDENTS,
  sales: process.env.DISCORD_WEBHOOK_SALES,
  verification: process.env.DISCORD_WEBHOOK_VERIFICATION,
  digest: process.env.DISCORD_WEBHOOK_DIGEST,
  approvals: process.env.DISCORD_WEBHOOK_APPROVALS,
};

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_IDS = {
  verification: process.env.DISCORD_VERIFICATION_CHANNEL_ID || null,
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
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[discordNotifier] HTTP ${res.status} to ${String(url).slice(0, 48)}...: ${body.slice(0, 300)}`);
    }
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
 * @param {{cooldownMs?: number, cooldownKey?: string, title?: string, fields?: Array<{name: string; value: string; inline?: boolean}>, color?: number, url?: string, timestamp?: string, components?: Array<{type: number; components: Array<{type: number; style?: number; label?: string; custom_id?: string; url?: string}>}>}} [opts]
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
    const embed = {
      title: opts.title || 'TravioAfrica',
      description: content,
      color: opts.color || 0x5865f2,
      fields: opts.fields || [],
    };
    if (opts.url) embed.url = opts.url;
    if (opts.timestamp) embed.timestamp = opts.timestamp;
    else embed.timestamp = new Date().toISOString();
    payload.embeds = [embed];
  } else {
    payload.content = content;
  }
  if (opts.components && opts.components.length) payload.components = opts.components;
  return post(url, payload);
}

/**
 * Send a notification via the bot token directly to a channel.
 * Interactive components (buttons) work because Discord associates them
 * with the bot application. Use this for notifications that need buttons.
 *
 * @param {'verification'|string} channel channel key from CHANNEL_IDS
 * @param {object} payload Discord message payload (embeds, components, etc.)
 * @returns {Promise<boolean>} true if sent successfully
 */
async function sendViaBot(channel, payload) {
  const channelId = CHANNEL_IDS[channel];
  if (!channelId || !BOT_TOKEN) {
    console.error(`[discordNotifier] sendViaBot: missing channel ID or bot token for "${channel}"`);
    return false;
  }
  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bot ${BOT_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[discordNotifier] sendViaBot HTTP ${res.status} to #${channel}: ${body.slice(0, 300)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[discordNotifier] sendViaBot failed for #${channel}: ${err.message}`);
    return false;
  }
}

/**
 * Update a webhook URL at runtime (called by the bot after creating a new
 * webhook owned by the application, so interactive buttons work).
 */
function updateWebhookUrl(channel, url) {
  if (channel && url) WEBHOOKS[channel] = url;
}

module.exports = { notifyDiscord, sendViaBot, updateWebhookUrl, WEBHOOKS };
