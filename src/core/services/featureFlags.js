/**
 * Feature flags for Sprint 1 storefront work.
 *
 * Every flag is an environment variable, read at call time (not cached at
 * import) so a process restart is the only requirement to flip a switch. The
 * defaults are deliberately OFF: a deploy must never turn on guest checkout,
 * recovery email or alert sweeps on its own.
 *
 * Naming: FF_<UPPER_SNAKE> in the environment, `camelCase` in code. `on`/`1`/
 * `true`/`yes` are truthy; everything else (including unset) is false.
 */

const FLAGS = {
  guestCheckout: 'FF_GUEST_CHECKOUT',
  checkoutRecovery: 'FF_CHECKOUT_RECOVERY',
  wishlistShare: 'FF_WISHLIST_SHARE',
  priceAlerts: 'FF_PRICE_ALERTS',
  waitlist: 'FF_WAITLIST',
  trustSignals: 'FF_TRUST_SIGNALS',
};

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function isEnabled(flag) {
  const envName = FLAGS[flag];
  if (!envName) return false;
  const raw = process.env[envName];
  return typeof raw === 'string' && TRUTHY.has(raw.trim().toLowerCase());
}

/** True when the flag exists at all — used by tests and the admin surface. */
function isKnown(flag) {
  return Object.prototype.hasOwnProperty.call(FLAGS, flag);
}

module.exports = { FLAGS, isEnabled, isKnown };
