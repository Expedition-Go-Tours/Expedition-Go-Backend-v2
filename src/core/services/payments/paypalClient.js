/**
 * PayPal REST transport.
 *
 * Deliberately boring: OAuth token cache, one JSON request helper, timeouts,
 * bounded retries and a typed error. It knows nothing about bookings — the
 * business layer above it decides what a call means.
 *
 * Retry rule: a request is retried only when it is safe to repeat. GETs always
 * are; POSTs only when the caller supplied a PayPal-Request-Id, which PayPal
 * uses as its idempotency key.
 */

const { paypalConfig } = require('./config');

const TOKEN_SAFETY_WINDOW_MS = 60 * 1000;
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_ATTEMPTS = 3;

let tokenCache = { key: null, token: null, expiresAt: 0 };
let tokenInFlight = null;

class PayPalApiError extends Error {
  constructor(message, {
    status = 0,
    code = null,
    errorName = null,
    details = null,
    retriable = false,
    requestId = null,
  } = {}) {
    super(message);
    this.name = 'PayPalApiError';
    this.status = status;
    this.code = code;
    this.errorName = errorName;
    this.details = details;
    this.retriable = retriable;
    this.requestId = requestId;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readError(payload, status) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const firstDetail = Array.isArray(body.details) && body.details.length ? body.details[0] : null;
  // PayPal's `name` is the transport-level category (UNPROCESSABLE_ENTITY,
  // INVALID_REQUEST, …) for nearly every business error; the machine-readable
  // reason the caller branches on — ORDER_NOT_APPROVED, INSTRUMENT_DECLINED,
  // ORDER_ALREADY_CAPTURED — lives on details[0].issue. Preferring `name` made
  // every one of those branches unreachable, so the specific issue wins and
  // `name` is kept for logs.
  const code = firstDetail?.issue || body.name || null;
  const message = body.message
    || firstDetail?.description
    || `PayPal request failed with HTTP ${status}`;
  return {
    code,
    errorName: body.name || null,
    message,
    details: body.details || null,
    requestId: body.debug_id || null,
  };
}

async function fetchAccessToken(config) {
  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const res = await fetch(`${config.baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  const text = await res.text();
  const payload = parseJson(text);

  if (!res.ok || !payload?.access_token) {
    const err = readError(payload, res.status);
    throw new PayPalApiError(`PayPal authentication failed: ${err.message}`, {
      status: res.status,
      code: err.code,
      errorName: err.errorName,
      details: err.details,
      retriable: isRetriableStatus(res.status),
      requestId: err.requestId,
    });
  }

  return {
    token: payload.access_token,
    expiresAt: Date.now() + Math.max(0, Number(payload.expires_in || 0) * 1000) - TOKEN_SAFETY_WINDOW_MS,
  };
}

/**
 * One token per credentials set, shared by concurrent callers. The in-flight
 * promise prevents a burst of checkouts from requesting a token each.
 */
async function getAccessToken(config = paypalConfig()) {
  const cacheKey = `${config.mode}:${config.clientId}`;
  if (tokenCache.key === cacheKey && tokenCache.token && tokenCache.expiresAt > Date.now()) {
    return tokenCache.token;
  }
  if (tokenInFlight) return tokenInFlight;

  tokenInFlight = fetchAccessToken(config)
    .then(({ token, expiresAt }) => {
      tokenCache = { key: cacheKey, token, expiresAt };
      return token;
    })
    .finally(() => {
      tokenInFlight = null;
    });

  return tokenInFlight;
}

/**
 * Invalidate the cached token (called after a 401 so the next call re-auths).
 */
function invalidateAccessToken() {
  tokenCache = { key: null, token: null, expiresAt: 0 };
}

async function request(path, {
  method = 'GET',
  body = null,
  idempotencyKey = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  attempts = DEFAULT_ATTEMPTS,
  config = paypalConfig(),
} = {}) {
  if (!config.clientId || !config.clientSecret) {
    throw new PayPalApiError('PayPal is not configured: missing client credentials', { retriable: false });
  }

  const idempotent = method === 'GET' || Boolean(idempotencyKey);
  const maxAttempts = idempotent ? Math.max(1, attempts) : 1;

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let token;
    try {
      token = await getAccessToken(config);
    } catch (err) {
      lastError = err;
      if (!err.retriable || attempt === maxAttempts) throw err;
      await sleep(250 * 2 ** (attempt - 1));
      continue;
    }

    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'PayPal-Request-Id': idempotencyKey || undefined,
    };

    let res;
    try {
      res = await fetch(`${config.baseUrl}${path}`, {
        method,
        headers,
        body: body === null ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastError = new PayPalApiError(`PayPal network error: ${err.message}`, {
        retriable: true,
        code: err.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK',
      });
      if (attempt === maxAttempts) throw lastError;
      await sleep(250 * 2 ** (attempt - 1));
      continue;
    }

    const text = await res.text();
    const payload = parseJson(text);

    if (res.ok) return payload;

    if (res.status === 401) {
      invalidateAccessToken();
      const err = readError(payload, res.status);
      lastError = new PayPalApiError(`PayPal authentication rejected: ${err.message}`, {
        status: res.status,
        code: err.code,
        errorName: err.errorName,
        retriable: attempt < maxAttempts,
        requestId: err.requestId,
      });
      if (attempt === maxAttempts) throw lastError;
      continue;
    }

    const err = readError(payload, res.status);
    lastError = new PayPalApiError(`PayPal ${method} ${path} failed: ${err.message}`, {
      status: res.status,
      code: err.code,
      errorName: err.errorName,
      details: err.details,
      retriable: isRetriableStatus(res.status),
      requestId: err.requestId,
    });

    if (!lastError.retriable || attempt === maxAttempts) throw lastError;
    await sleep(250 * 2 ** (attempt - 1));
  }

  throw lastError || new PayPalApiError('PayPal request failed');
}

module.exports = {
  PayPalApiError,
  request,
  getAccessToken,
  invalidateAccessToken,
  sleep,
};
