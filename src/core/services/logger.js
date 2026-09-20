const { Logtail } = require('@logtail/node');

const LOGTAIL_TOKEN = process.env.LOGTAIL_TOKEN;

const LOGTAIL_HOST = process.env.LOGTAIL_HOST || 'https://in.logs.betterstack.com';

let logtail = null;

if (LOGTAIL_TOKEN) {
  try {
    logtail = new Logtail(LOGTAIL_TOKEN, { endpoint: LOGTAIL_HOST });
  } catch (err) {
    console.warn('[Logger] Failed to init Logtail:', err.message);
  }
}

function info(message, meta) {
  if (logtail) {
    logtail.info(message, meta).catch((err) => console.warn('[Logger] Failed to send info:', err?.message));
  } else {
    console.log(message, meta || '');
  }
}

function warn(message, meta) {
  if (logtail) {
    logtail.warn(message, meta).catch((err) => console.warn('[Logger] Failed to send warn:', err?.message));
  } else {
    console.warn(message, meta || '');
  }
}

function error(message, meta) {
  if (logtail) {
    logtail.error(message, meta).catch((err) => console.warn('[Logger] Failed to send error:', err?.message));
  } else {
    console.error(message, meta || '');
  }
}

function httpLog(method, url, status, responseTimeMs, meta) {
  const message = `${method} ${url} ${status} ${responseTimeMs}ms`;
  if (logtail) {
    logtail.info(message, { method, url, status, responseTimeMs, ...meta }).catch((err) => console.warn('[Logger] Failed to send httpLog:', err?.message));
  } else {
    console.log(`[${new Date().toISOString()}] ${message}`);
  }
}

async function flush() {
  if (logtail) {
    try { await logtail.flush(); } catch (err) { console.warn('[Logger] Flush failed:', err?.message); }
  }
}

module.exports = { info, warn, error, httpLog, flush };
