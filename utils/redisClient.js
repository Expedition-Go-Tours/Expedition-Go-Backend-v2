const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL;

let connection = null;
let isConnected = false;
let connecting = false;
let connectionFailed = false;
let connectionFailedAt = 0;

function getConnection() {
  if (!connection) {
    connection = new Redis(REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
      retryStrategy(times) {
        // Allow retry after 60 seconds even if connectionFailed
        if (connectionFailed && Date.now() - connectionFailedAt < 60000) return null;
        if (times > 10) return null;
        return Math.min(times * 200, 3000);
      },
      tls: REDIS_URL && REDIS_URL.startsWith('rediss://') ? {} : undefined
    });

    connection.on('connect', () => { isConnected = true; connecting = false; connectionFailed = false; });
    connection.on('close', () => { isConnected = false; });
    connection.on('error', (err) => {
      if (err.message && err.message.includes('max requests limit')) {
        connectionFailed = true;
        connectionFailedAt = Date.now();
      }
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[Redis]', err.message);
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
  return isConnected && connection !== null;
}

async function isRedisAvailable() {
  try {
    const conn = getConnection();
    await conn.connect();
    await conn.ping();
    if (connectionFailed) return false;
    connectionFailed = false;
    return true;
  } catch (err) {
    connectionFailed = true;
    if (err.message && err.message.includes('max requests limit')) {
      console.warn('[Redis] Upstash Redis rate limit exceeded — using inline fallbacks');
    }
    return false;
  }
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

async function quit() {
  if (connection) {
    try {
      await connection.quit();
    } catch { /* silent */ }
    connection = null;
    isConnected = false;
    connectionFailed = false;
  }
}

module.exports = {
  connect,
  getClient,
  getConnection,
  isReady,
  isRedisAvailable,
  get,
  set,
  setnx,
  del,
  delPattern,
  quit
};
