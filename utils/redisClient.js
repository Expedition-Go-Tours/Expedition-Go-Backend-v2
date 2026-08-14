const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL;

const QUOTA_COOLDOWN_MS = 5 * 60 * 1000; // recovery probe interval while quota-limited
const PROBE_KEY = 'health:probe';
const COMMAND_TIMEOUT_MS = 3000;

let connection = null;
let isConnected = false;
let connecting = false;
let connectionFailed = false;
let connectionFailedAt = 0;
let lastErrorKind = null; // 'limit' | 'other' | null
let recoveryTimer = null;

function isLimitError(err) {
  return !!err && typeof err.message === 'string' && err.message.includes('max requests limit');
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Redis command timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * While degraded (quota-limited), probe with a REAL command on a slow cadence.
 * PING is not trustworthy — Upstash can keep answering PING while every other
 * command returns the limit error, which is why health checks were lying.
 */
function scheduleRecovery() {
  if (recoveryTimer) return;
  recoveryTimer = setTimeout(async () => {
    recoveryTimer = null;
    if (!connectionFailed && lastErrorKind !== 'limit') return;
    const ok = await probe();
    if (!ok && lastErrorKind === 'limit') scheduleRecovery();
  }, QUOTA_COOLDOWN_MS);
  if (recoveryTimer && recoveryTimer.unref) recoveryTimer.unref();
}

function getConnection() {
  if (!connection) {
    connection = new Redis(REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
      retryStrategy(times) {
        // Don't reconnect within the quota cooldown — avoids hammering Upstash.
        if (connectionFailed && lastErrorKind === 'limit' && Date.now() - connectionFailedAt < QUOTA_COOLDOWN_MS) return null;
        if (times > 10) return null;
        return Math.min(times * 200, 3000);
      },
      tls: REDIS_URL && REDIS_URL.startsWith('rediss://') ? {} : undefined
    });

    connection.on('connect', () => {
      isConnected = true;
      connecting = false;
      // Quota degradation must NOT be cleared by a TCP reconnect — only a real
      // command (probe) proves the limit window reset. Transient blips recover fast.
      if (lastErrorKind !== 'limit') connectionFailed = false;
    });
    connection.on('close', () => { isConnected = false; });
    connection.on('error', (err) => {
      if (isLimitError(err)) {
        const wasFailed = connectionFailed;
        connectionFailed = true;
        connectionFailedAt = Date.now();
        lastErrorKind = 'limit';
        scheduleRecovery();
        if (!wasFailed) {
          console.warn('[Redis] Upstash request limit exceeded — entering degraded mode (inline fallbacks active)');
        }
      } else {
        lastErrorKind = 'other';
        if (process.env.NODE_ENV !== 'production') {
          console.warn('[Redis]', err.message);
        }
      }
    });
  }
  return connection;
}

async function connect() {
  if (connection && isConnected) return connection;
  if (connecting) return null;
  if (!REDIS_URL) return null;
  connecting = true;

  const conn = getConnection();
  try {
    await conn.connect();
    isConnected = true;
    connecting = false;
  } catch {
    // Disconnect orphaned instance to release sockets
    try { conn.disconnect(); } catch { /* ignore */ }
    connection = null;
    isConnected = false;
    connecting = false;
  }

  return conn;
}

function getClient() {
  return connection;
}

function isReady() {
  return isConnected && connection !== null && !connectionFailed;
}

async function isRedisAvailable() {
  // While quota-limited, report unavailable WITHOUT pinging — PING can lie.
  if (connectionFailed && lastErrorKind === 'limit') return false;
  try {
    const conn = getConnection();
    if (conn.status !== 'ready') {
      await withTimeout(conn.connect(), COMMAND_TIMEOUT_MS);
    }
    await withTimeout(conn.ping(), COMMAND_TIMEOUT_MS);
    connectionFailed = false;
    lastErrorKind = null;
    return true;
  } catch (err) {
    connectionFailed = true;
    connectionFailedAt = Date.now();
    lastErrorKind = isLimitError(err) ? 'limit' : 'other';
    if (lastErrorKind === 'limit') {
      console.warn('[Redis] Upstash request limit exceeded — entering degraded mode (inline fallbacks active)');
      scheduleRecovery();
    }
    return false;
  }
}

/**
 * Real-command health probe (GET, not PING). Used at boot and for recovery.
 * Only a successful real command clears quota degradation.
 */
async function probe() {
  if (!connection) return false;
  try {
    if (connection.status !== 'ready') {
      await withTimeout(connection.connect(), COMMAND_TIMEOUT_MS);
    }
    await withTimeout(connection.get(PROBE_KEY), COMMAND_TIMEOUT_MS);
    connectionFailed = false;
    lastErrorKind = null;
    return true;
  } catch (err) {
    connectionFailed = true;
    connectionFailedAt = Date.now();
    lastErrorKind = isLimitError(err) ? 'limit' : 'other';
    if (lastErrorKind === 'limit') scheduleRecovery();
    return false;
  }
}

/**
 * Mark Redis unavailable from a command failure (e.g. a queue worker hitting
 * the Upstash limit). Keeps the connection open so enqueue calls still reject
 * and inline fallbacks fire, but flips isReady/isRedisAvailable to false.
 */
function markUnavailable(err) {
  const wasFailed = connectionFailed;
  const limit = isLimitError(err);
  connectionFailed = true;
  connectionFailedAt = Date.now();
  lastErrorKind = limit ? 'limit' : 'other';
  if (limit) {
    scheduleRecovery();
    if (!wasFailed) {
      console.warn('[Redis] Upstash request limit exceeded — entering degraded mode (inline fallbacks active)');
    }
  }
  return connectionFailed;
}

async function get(key) {
  if (!isReady()) return null;
  try {
    const val = await connection.get(key);
    return val ? JSON.parse(val) : null;
  } catch {
    return null;
  }
}

async function set(key, data, ttlSeconds = 300) {
  if (!isReady()) return;
  try {
    const val = JSON.stringify(data);
    if (ttlSeconds > 0) {
      await connection.setex(key, ttlSeconds, val);
    } else {
      await connection.set(key, val);
    }
  } catch { /* silent fail */ }
}

/**
 * Atomically set a key only if it does not already exist, with a TTL.
 * Used for idempotency/dedup guards (e.g. tour view cooldowns).
 * @returns {Promise<boolean|null>} true = newly set; false = key already existed; null = Redis unavailable
 */
async function setnx(key, ttlSeconds = 300) {
  if (!isReady()) return null;
  try {
    const res = await connection.set(key, '1', 'EX', ttlSeconds, 'NX');
    return res === 'OK';
  } catch {
    return null;
  }
}

async function del(key) {
  if (!isReady()) return;
  try {
    await connection.del(key);
  } catch { /* silent fail */ }
}

async function delPattern(pattern) {
  if (!isReady()) return;
  try {
    const stream = connection.scanStream({ match: pattern, count: 100 });
    const pipeline = connection.pipeline();
    stream.on('data', (keys) => {
      if (keys.length) {
        keys.forEach((k) => pipeline.del(k));
      }
    });

    await new Promise((resolve, _reject) => {
      stream.on('end', () => {
        pipeline.exec()
          .then(() => resolve())
          .catch((err) => {
            console.warn('[Redis] delPattern pipeline failed:', err?.message);
            resolve(); // don't reject — best-effort
          });
      });
      stream.on('error', (err) => {
        console.warn('[Redis] delPattern scan failed:', err?.message);
        resolve(); // best-effort
      });
      stream.read();
    });
  } catch { /* silent fail */ }
}

/**
 * Pub/sub clients for the Socket.IO Redis adapter, derived from the SAME
 * underlying connection (options + degraded-mode state) as everything else.
 *
 * Each client gets an `error` handler that funnels into `markUnavailable`, so
 * an Upstash throttle or dropped TLS socket can never surface as an unhandled
 * 'error' event (previously an uncaughtException that crashed the process).
 * Their retry strategy keeps slowly retrying during quota cooldown so the
 * adapter auto-reconnects once Upstash resets the limit window.
 *
 * @returns {{ pub: import('ioredis').Redis, sub: import('ioredis').Redis }}
 */
function getPubSubClients() {
  const base = getConnection();
  const make = () => {
    const client = base.duplicate({
      retryStrategy(times) {
        if (connectionFailed && lastErrorKind === 'limit' && Date.now() - connectionFailedAt < QUOTA_COOLDOWN_MS) {
          return QUOTA_COOLDOWN_MS;
        }
        if (times > 20) return null;
        return Math.min(times * 200, 3000);
      },
    });
    client.on('error', (err) => {
      if (isLimitError(err)) {
        const wasFailed = connectionFailed;
        markUnavailable(err);
        if (!wasFailed) {
          console.warn('[Socket.IO] Upstash request limit exceeded — adapter degraded, retrying slowly');
        }
      } else if (process.env.NODE_ENV !== 'production') {
        console.warn('[Socket.IO] Redis adapter error:', err.message);
      }
    });
    return client;
  };
  return { pub: make(), sub: make() };
}

async function quit() {
  if (recoveryTimer) {
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }
  if (connection) {
    try {
      await connection.quit();
    } catch { /* silent */ }
    connection = null;
    isConnected = false;
    connectionFailed = false;
    lastErrorKind = null;
  }
}

module.exports = {
  connect,
  getClient,
  getConnection,
  isReady,
  isRedisAvailable,
  probe,
  markUnavailable,
  isLimitError,
  getPubSubClients,
  get,
  set,
  setnx,
  del,
  delPattern,
  quit
};
