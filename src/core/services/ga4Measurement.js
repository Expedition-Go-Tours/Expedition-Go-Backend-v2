/**
 * GA4 Measurement Protocol — server-side purchase and refund reporting.
 *
 * The storefront can only report what the browser sees; a booking is settled by
 * a Stripe webhook (or a pay-later sweep / admin "charge now") long after the
 * customer's tab closed. So the money events are reported here, from the single
 * exactly-once settlement hook `notifyBookingsSettled()` and the refund
 * branches of `stripeHelpers.js`.
 *
 * The Measurement Protocol has no Consent Mode: there is no cookie and no
 * client-side signal. Consent is therefore re-checked against the choice stored
 * on the booking (`analyticsConsent`) and the visitor's GA4 `client_id`
 * (`gaClientId`) must be present. A booking with no consent, or made before
 * this was captured, is skipped — and every outcome (sent, or skipped with its
 * exact reason) leaves ONE `[ga4Measurement] ...` line in the pm2 logs, so a
 * delivered or dropped money event is always diagnosable after the fact.
 *
 * A delivered purchase is also stamped on the booking (`Booking.ga4ReportedAt`).
 * Logs rotate; the column does not. That is what scripts/ga4-reconcile.js reads
 * to answer "which settled bookings never reached GA?", which is the question
 * nobody could answer after the secret incident.
 *
 * Safe by design, like discordNotifier:
 *  - No-op (resolves immediately) when GA4_MEASUREMENT_ID / GA4_API_SECRET unset.
 *  - Never throws — every failure is caught and logged.
 *  - Fire-and-forget: callers do not await, and a slow/blocked GA can never
 *    delay or fail a settled booking.
 *
 * Required env (see .env.example):
 *   GA4_MEASUREMENT_ID=G-XXXXXXXXXX
 *   GA4_API_SECRET=<Measurement Protocol API secret>
 *
 * Docs: https://developers.google.com/analytics/devguides/collection/protocol/ga4
 */

const fs = require('fs');
const path = require('path');

const MEASUREMENT_ENDPOINT = 'https://www.google-analytics.com/mp/collect';
const REQUEST_TIMEOUT_MS = 5000;

/** The only two keys whose deployed .env value must win over the process env. */
const ENV_KEYS = ['GA4_MEASUREMENT_ID', 'GA4_API_SECRET'];

/** Measurement Protocol is only usable when both the id and the secret are set. */
function isEnabled() {
  return Boolean(process.env.GA4_MEASUREMENT_ID && process.env.GA4_API_SECRET);
}

/**
 * GA4 API secrets are generated tokens (base64url-ish, typically 22 chars). The
 * value that most often gets pasted here by mistake is the numeric data-stream
 * ID from the same Admin page, which is accepted with HTTP 204 and then
 * discarded — a silent, permanent zero-revenue failure. There is no runtime
 * signal from GA, so this cheap shape check is the only guard.
 */
function isPlausibleApiSecret(secret) {
  if (typeof secret !== 'string') return false;
  if (secret.length < 16) return false;
  if (/^[0-9]+$/.test(secret)) return false;
  return true;
}

/** Boot-time alarm: a configured-but-impossible secret must never be quiet. */
function warnIfMisconfigured() {
  if (!isEnabled()) return;
  if (isPlausibleApiSecret(process.env.GA4_API_SECRET)) return;
  console.error(
    '[ga4Measurement] GA4_API_SECRET looks like a data-stream ID, not an API secret ' +
      '(all digits or too short). GA will answer 204 and discard every event. ' +
      'Create a secret under Admin > Data Streams > (stream) > Measurement Protocol API secrets.'
  );
}

warnIfMisconfigured();

/**
 * Make the deployed `.env` the source of truth for the GA4 credentials.
 *
 * Why this exists: on 2026-10-30 the API was running with the numeric
 * data-stream ID as `GA4_API_SECRET` while `.env` on disk already held the real
 * secret. `dotenv` never overwrites a key that is already in `process.env`, and
 * pm2 keeps its own copy of the environment across restarts, so editing `.env`
 * and bouncing the app was not enough — the stale (silently rejected) value won
 * every time, and GA discarded a week of purchase events.
 *
 * These two keys are therefore re-read from the file and applied over whatever
 * the process inherited, with one warning when they disagree. Values are never
 * printed, only lengths. Missing keys in `.env` leave the process env alone, so
 * a secret manager can still supply them.
 *
 * @param {string} [envPath] defaults to `.env` in the working directory
 * @returns {{ applied: string[], shadowed: string[] }} keys taken from the file
 *   (absent from the process env) and keys that overrode a different value
 */
function reconcileEnvFromFile(envPath) {
  const report = { applied: [], shadowed: [] };
  const file = envPath || path.resolve(process.cwd(), '.env');

  let fileEnv;
  try {
    fileEnv = require('dotenv').parse(fs.readFileSync(file));
  } catch {
    // No readable .env: whatever the process carries is all we have.
    return report;
  }

  for (const key of ENV_KEYS) {
    const fromFile = String(fileEnv[key] == null ? '' : fileEnv[key]).trim();
    if (!fromFile) continue;

    const fromProcess = String(process.env[key] == null ? '' : process.env[key]).trim();
    if (fromProcess === fromFile) continue;

    process.env[key] = fromFile;
    if (!fromProcess) {
      report.applied.push(key);
      continue;
    }

    report.shadowed.push(key);
    console.warn(
      `[ga4Measurement] ${key} in the process environment differed from .env ` +
        `(${fromProcess.length} vs ${fromFile.length} chars); using the .env value. ` +
        'pm2 keeps its own copy of the environment — after editing .env restart with ' +
        '`pm2 restart <app> --update-env` (or let the deploy pipeline do it).'
    );
  }

  return report;
}

/** Money must be a finite, non-negative number before it reaches GA. */
function toAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Number(n.toFixed(2)) : null;
}

/**
 * The consent + identity gate shared by every event. Returns the client_id when
 * the booking may be reported, otherwise null. Never throws.
 */
function resolveClientId(booking) {
  if (!booking) return null;
  if (booking.analyticsConsent !== true) return null;
  const clientId = typeof booking.gaClientId === 'string' ? booking.gaClientId.trim() : '';
  return clientId || null;
}

/**
 * GA4 ecommerce item for a booking. `quantity` is 1 and the whole booking value
 * sits on `price` so `value` and the item total always reconcile.
 */
function buildItem(booking, amount) {
  return {
    item_id: booking.tourId || booking.id,
    item_name: booking.tour?.title || 'Tour booking',
    price: amount,
    quantity: 1,
  };
}

/**
 * Pure builders — the event body for a settled booking and for a refund. Kept
 * separate from transport so they can be asserted without network mocking.
 * Both return null when the booking must not be reported.
 */
function buildPurchaseEvent(booking) {
  const clientId = resolveClientId(booking);
  if (!clientId) return null;
  const value = toAmount(booking.grossAmount);
  if (value === null) return null;

  return {
    client_id: clientId,
    events: [
      {
        name: 'purchase',
        params: {
          transaction_id: booking.bookingNumber,
          currency: booking.currency || 'USD',
          value,
          // 'later' distinguishes a deferred reservation charge from a pay-now
          // purchase without needing a separate revenue event.
          payment_timing: booking.paymentTiming === 'later' ? 'later' : 'now',
          items: [buildItem(booking, value)],
        },
      },
    ],
  };
}

function buildRefundEvent(booking, valueOverride) {
  const clientId = resolveClientId(booking);
  if (!clientId) return null;
  // The triggering refund's own amount (from the charge) wins; otherwise fall
  // back to the booking's stored refundAmount, then the original total.
  const raw = valueOverride != null
    ? valueOverride
    : (booking.refundAmount != null ? booking.refundAmount : booking.grossAmount);
  const value = toAmount(raw);
  if (value === null || value <= 0) return null;

  return {
    client_id: clientId,
    events: [
      {
        name: 'refund',
        params: {
          transaction_id: booking.bookingNumber,
          currency: booking.currency || 'USD',
          value,
        },
      },
    ],
  };
}

/**
 * Why a booking produced no event. Mirrors resolveClientId + the amount gate so
 * the log names the exact drop: a declined consent, attribution that was never
 * captured (pre-feature or non-store flow), a missing client_id, or a bad total.
 */
function skipReason(booking) {
  if (!booking) return 'no-booking';
  if (booking.analyticsConsent === false) return 'no-consent';
  if (booking.analyticsConsent !== true) return 'no-attribution';
  const clientId = typeof booking.gaClientId === 'string' ? booking.gaClientId.trim() : '';
  if (!clientId) return 'no-client-id';
  return 'no-amount';
}

/** One line per skipped event: a silent drop must never be invisible in prod. */
function logSkip(kind, booking, reason) {
  const ref = (booking && booking.bookingNumber) || 'unknown';
  console.log(`[ga4Measurement] ${kind} skipped booking=${ref} reason=${reason}`);
}

/**
 * GA accepts a request with an unusable secret and still answers 204, so a
 * wrong secret is indistinguishable from success at the transport layer. The
 * shape check is therefore the gate: without it we would keep logging `sent`
 * for events Google had already thrown away.
 */
function refuseIfBadSecret(kind, booking) {
  if (isPlausibleApiSecret(process.env.GA4_API_SECRET)) return false;
  console.error(
    '[ga4Measurement] GA4_API_SECRET is not a Measurement Protocol secret (all digits or too short). ' +
      'Refusing to send: GA would answer 204 and discard the event. ' +
      'Create one under Admin > Data Streams > (stream) > Measurement Protocol API secrets.'
  );
  logSkip(kind, booking, 'invalid-secret');
  return true;
}

/** POST one Measurement Protocol body. Always resolves; never throws. */
async function deliver(body, { kind, ref } = {}) {
  const label = kind || 'event';
  const bookingRef = ref || 'unknown';
  const event = body && body.events && body.events[0];
  const tail = event
    ? `tx=${event.params.transaction_id} value=${event.params.value} ${event.params.currency}`
    : '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = `${MEASUREMENT_ENDPOINT}?measurement_id=${encodeURIComponent(process.env.GA4_MEASUREMENT_ID)}&api_secret=${encodeURIComponent(process.env.GA4_API_SECRET)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[ga4Measurement] ${label} send failed booking=${bookingRef} HTTP ${res.status}: ${text.slice(0, 300)}`);
      return { ok: false, reason: `http-${res.status}` };
    }
    console.log(`[ga4Measurement] ${label} sent booking=${bookingRef} ${tail}`);
    return { ok: true };
  } catch (err) {
    console.error(`[ga4Measurement] ${label} send failed booking=${bookingRef}: ${err.message}`);
    return { ok: false, reason: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Record that GA accepted the purchase for this booking.
 *
 * "Sent" used to mean only "the HTTP call resolved", which is not the same as
 * "GA kept it". Persisting the acknowledgement turns the question "did this
 * booking reach GA?" into one indexed lookup instead of a grep through rotated
 * logs. Best-effort: a database hiccup must never fail or delay a booking.
 */
async function markReported(booking) {
  if (!booking || !booking.id) return;
  try {
    const prisma = require('./prismaClient');
    await prisma.booking.update({
      where: { id: booking.id },
      data: { ga4ReportedAt: new Date() },
    });
  } catch (err) {
    console.warn(
      `[ga4Measurement] could not record delivery booking=${booking.bookingNumber || booking.id}: ${err.message}`
    );
  }
}


/**
 * Report a settled booking as a purchase. Fire-and-forget. Exactly one log line
 * per call: either the `sent` line (with tx + value) or a `skipped` line naming
 * the reason. Resolves with `{ ok, reason }` so a caller that wants to know can
 * find out; the settlement hook ignores it.
 * @param {object} booking a booking with gaClientId + analyticsConsent + tour included
 * @param {{ timestampMicros?: number, extraParams?: object }} [opts]
 *   `timestamp_micros` stamps historical re-reports (GA4 accepts at most 72h
 *   back). `extraParams` adds custom parameters, e.g. the reconciliation
 *   markers a backfill carries so a wrongly-dated event can still be explained.
 */
function sendPurchase(booking, { timestampMicros, extraParams } = {}) {
  const ref = (booking && booking.bookingNumber) || 'unknown';
  if (!isEnabled()) {
    logSkip('purchase', booking, 'not-configured');
    return Promise.resolve({ ok: false, reason: 'not-configured' });
  }
  if (refuseIfBadSecret('purchase', booking)) {
    return Promise.resolve({ ok: false, reason: 'invalid-secret' });
  }
  const body = buildPurchaseEvent(booking);
  if (!body) {
    const reason = skipReason(booking);
    logSkip('purchase', booking, reason);
    return Promise.resolve({ ok: false, reason });
  }
  if (timestampMicros) body.events[0].params.timestamp_micros = timestampMicros;
  if (extraParams) Object.assign(body.events[0].params, extraParams);
  return deliver(body, { kind: 'purchase', ref }).then(async (outcome) => {
    if (outcome.ok) await markReported(booking);
    return outcome;
  });
}

/**
 * Report a refund against the original purchase (matched by transaction_id).
 * Fire-and-forget.
 * @param {object} booking a booking with gaClientId + analyticsConsent + tour included
 * @param {{ value?: number }} [opts] explicit refund amount (major units) when the
 *   booking row does not yet carry it (e.g. reported straight from the charge)
 */
function sendRefund(booking, { value, timestampMicros } = {}) {
  const ref = (booking && booking.bookingNumber) || 'unknown';
  if (!isEnabled()) {
    logSkip('refund', booking, 'not-configured');
    return Promise.resolve({ ok: false, reason: 'not-configured' });
  }
  if (refuseIfBadSecret('refund', booking)) return Promise.resolve({ ok: false, reason: 'invalid-secret' });
  const body = buildRefundEvent(booking, value);
  if (!body) {
    const reason = skipReason(booking);
    logSkip('refund', booking, reason);
    return Promise.resolve({ ok: false, reason });
  }
  if (timestampMicros) body.events[0].params.timestamp_micros = timestampMicros;
  return deliver(body, { kind: 'refund', ref });
}

module.exports = {
  buildPurchaseEvent,
  buildRefundEvent,
  sendPurchase,
  sendRefund,
  isEnabled,
  isPlausibleApiSecret,
  reconcileEnvFromFile,
};
