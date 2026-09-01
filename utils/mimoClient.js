/**
 * Shared MiMo (Xiaomi) API client.
 *
 * Dependency-free — uses native fetch.  Used by:
 *   - utils/aiContentAnalyzer.js (tour image/content analysis)
 *   - utils/adminNotificationService.js / controllers/disputeController.js (dispute recommendation)
 *   - bots/discord-bot/index.js (slash commands: /ask, /chat)
 *   - scripts/dailyDigest.js (AI digest summary)
 *
 * MiMo v2.5 is a reasoning model — the actual answer may live in
 * `reasoning_content` when max_tokens is low, so we fall back.
 *
 * @version 1.0.0
 */

const MIMO_API_URL = 'https://token-plan-sgp.xiaomimimo.com/v1/chat/completions';
const DEFAULT_MODEL = 'mimo-v2.5';
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 60000;

/**
 * Call MiMo with retry logic and timeout.
 *
 * @param {Object} opts
 * @param {string} opts.system  - System prompt
 * @param {string} opts.user    - User message
 * @param {number} [opts.maxTokens=4096]  - Max completion tokens
 * @param {number} [opts.temperature=0.2] - Temperature (0–1)
 * @param {string} [opts.model] - Override model name
 * @returns {Promise<string>} Raw completion text
 */
async function callMimo({ system, user, maxTokens = 4096, temperature = 0.2, model } = {}) {
  const apiKey = process.env.MIMO_API_KEY;
  if (!apiKey) throw new Error('MIMO_API_KEY not set in environment');

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });

  const body = {
    model: model || process.env.MIMO_MODEL || DEFAULT_MODEL,
    messages,
    max_completion_tokens: maxTokens,
    temperature,
  };

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(MIMO_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('retry-after') || '5', 10);
        if (attempt === MAX_RETRIES) throw new Error(`MiMo API 429: rate limited after ${MAX_RETRIES} retries`);
        await sleep(retryAfter * 1000);
        continue;
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`MiMo API ${response.status}: ${text.slice(0, 200)}`);
      }

      const data = await response.json();
      const msg = data.choices?.[0]?.message;
      const content = msg?.content || msg?.reasoning_content;
      if (!content) throw new Error('MiMo returned empty content');
      return content;
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        if (attempt === MAX_RETRIES) throw new Error('MiMo request timed out');
      } else if (attempt === MAX_RETRIES) {
        throw err;
      }
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }
}

/**
 * Parse JSON from MiMo response, stripping markdown code fences if present.
 */
function parseJson(text) {
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
  return JSON.parse(cleaned);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { callMimo, parseJson };
