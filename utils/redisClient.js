const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL;

let connection = null;
let isConnected = false;
let connecting = false;
let connectionFailed = false;

function getConnection() {
  if (!connection) {
    connection = new Redis(REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
      retryStrategy(times) {
        if (connectionFailed) return null;
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
    stream.on('end', () => pipeline.exec().catch((err) => console.warn('[Redis] delPattern pipeline failed:', err?.message)));
    stream.read();
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
  del,
  delPattern,
  quit
};
