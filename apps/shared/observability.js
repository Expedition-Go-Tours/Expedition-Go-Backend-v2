/**
 * Shared process-level runtime setup for both API applications.
 *
 * Two apps, two processes, one implementation. Anything in here runs once per
 * process and must behave identically whether it is the Platform API or the
 * Stays API — otherwise a bug report cannot be compared across services.
 */

/**
 * Prisma can return `BigInt` from raw SQL aggregates (COUNT, SUM). JSON has no
 * BigInt type, so `JSON.stringify` throws without this polyfill. It used to
 * live inline at the top of `app.js`; keeping it here means the Stays app gets
 * the same guarantee without copying the code.
 */
function installBigIntJson() {
  if (typeof BigInt.prototype.toJSON === 'function') return;
  BigInt.prototype.toJSON = function () {
    return Number(this);
  };
}

/**
 * Initialise Sentry at most once per process.
 *
 * Requiring both application modules in a single test process (which the
 * architecture tests do) would otherwise call `Sentry.init` twice. The second
 * call is ignored by the SDK but logs a warning that looks like a bug.
 */
let sentryInitialised = false;

function initSentry(service) {
  const Sentry = require('@sentry/node');
  if (sentryInitialised || Sentry.getClient()) {
    sentryInitialised = true;
    return Sentry;
  }

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    // Every event carries the owning application, so a shared Sentry project
    // can still tell platform-api failures from stays-api failures.
    initialScope: {
      tags: { service },
    },
    release: process.env.RELEASE_VERSION
      ? `${service}@${process.env.RELEASE_VERSION}`
      : undefined,
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    ignoreErrors: ['Object [object Object] has no method'],
  });

  sentryInitialised = true;
  return Sentry;
}

module.exports = {
  installBigIntJson,
  initSentry,
};
