const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL;

let redis = null;
let isConnected = false;
let connecting = false;

function createClient() {
  if (!REDIS_URL) return null;

  const client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      if (times > 3) return null;
      return Math.min(times * 200, 2000);
    },
    lazyConnect: true,
    enableOfflineQueue: false,
    tls: REDIS_URL.startsWith('rediss://') ? {} : undefined
  });

  client.on('connect', () => { isConnected = true; connecting = false; });
  client.on('close', () => { isConnected = false; });
  client.on('error', (err) => {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[Redis]', err.message);
    }
  });

  return client;
}

async function connect() {
  if (redis) return redis;
  if (connecting) return null;
  connecting = true;

  redis = createClient();
  if (!redis) return null;

  try {
    await redis.connect();
  } catch {
    redis = null;
    isConnected = false;
    connecting = false;
  }

  return redis;
}

function getClient() {
  return redis;
}

function isReady() {
  return isConnected && redis !== null;
}

async function get(key) {
  if (!isReady()) return null;
  try {
    const val = await redis.get(key);
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
      await redis.setex(key, ttlSeconds, val);
    } else {
      await redis.set(key, val);
    }
  } catch { /* silent fail */ }
}

async function del(key) {
  if (!isReady()) return;
  try {
    await redis.del(key);
  } catch { /* silent fail */ }
}

async function delPattern(pattern) {
  if (!isReady()) return;
  try {
    const stream = redis.scanStream({ match: pattern, count: 100 });
    const pipeline = redis.pipeline();
    stream.on('data', (keys) => {
      if (keys.length) {
        keys.forEach((k) => pipeline.del(k));
      }
    });
    stream.on('end', () => pipeline.exec().catch(() => {}));
    stream.read();
  } catch { /* silent fail */ }
}

async function quit() {
  if (redis) {
    try {
      await redis.quit();
    } catch { /* silent */ }
    redis = null;
    isConnected = false;
  }
}

module.exports = {
  connect,
  getClient,
  isReady,
  get,
  set,
  del,
  delPattern,
  quit
};
