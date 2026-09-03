/**
 * Distributed run-lock for the in-process scheduler sweeps.
 *
 * Lets every PM2 worker (or machine) keep its own timer, but guarantees only
 * ONE of them executes a given sweep at a time when Redis is healthy:
 *
 *   acquireRunLock(key, ttlMs)
 *     → token    lock acquired (caller owns the sweep window)
 *     → false    another owner holds the lock → caller should SKIP
 *     → null     Redis unreachable / no client → caller should fall back to
 *                the single-leader (NODE_APP_INSTANCE === '0') behaviour
 *
 * Release uses a Lua compare-and-delete keyed on the random ownership token,
 * so a stale owner can never delete a NEW owner's lock after its own TTL
 * expired (the classic "A finishes late and DELs B's lock" race).
 *
 * IMPORTANT: this is NOT an exactly-once guarantee. If the lock owner crashes
 * and its TTL expires, another worker may run the same sweep. Every sweep
 * handled here must therefore be idempotent (guarded DB status transitions,
 * Stripe PaymentIntent semantics, etc.), which the existing booking/pay-later
 * sweep code already ensures.
 */
const crypto = require('crypto');
const { getClient, isReady } = require('./redisClient');

async function acquireRunLock(key, ttlMs) {
  if (!isReady()) return null; // Redis down → caller uses the leader fallback
  const conn = getClient();
  if (!conn) return null;
  const token = crypto.randomBytes(16).toString('hex');
  try {
    const ok = await conn.set(key, token, 'PX', ttlMs, 'NX');
    return ok === 'OK' ? token : false;
  } catch {
    return null;
  }
}

async function releaseRunLock(key, token) {
  if (!token) return;
  const conn = getClient();
  if (!conn) return;
  try {
    await conn.eval(
      `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`,
      1,
      key,
      token
    );
  } catch {
    // Non-fatal — the lock TTL will expire on its own.
  }
}

module.exports = { acquireRunLock, releaseRunLock };
