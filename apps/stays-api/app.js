/**
 * Stays API — composition root.
 *
 * Owns the accommodation vertical: properties, builder payloads, room types,
 * rate plans, availability overrides, supplier-created reservations, offers,
 * stay finance/payout requests, refund claims and accommodation verification.
 *
 * It is a second, independent process. Starting it does NOT start the Platform
 * API, and it deliberately does not load:
 *
 *   - Socket.IO            (no realtime channels are Stays-owned)
 *   - BullMQ workers       (no Stays queues exist yet)
 *   - scheduled jobs       (registration belongs to the Platform API alone)
 *   - Tours routers        (tour bookings, expedition, availability calendar)
 *   - webhook receivers    (Stripe/PayPal live on the Platform API)
 *
 * That omission is the point of the split: a Stays-only release must not be
 * able to duplicate a scheduler or consume a Platform queue.
 *
 * Security is not re-implemented. The exact same `protect` (Bearer header or
 * `accessToken` cookie → JWT verify → live user row) and the exact same
 * `resolveSupplier` (DB-backed supplier ownership OR accepted team membership)
 * middlewares guard these routes here as they did under the Platform app. No
 * `X-User-Id` / `X-Supplier-Id` header is trusted, because none is read.
 *
 * URL contract
 * ------------
 *   /api/travioghana/supplier/stays/*      legacy alias (unchanged)
 *   /api/v1/travioghana/supplier/stays/*   canonical
 *
 * Both prefixes mount the SAME router instance. There is no forked controller
 * and no second copy of the permission map.
 */

const { installBigIntJson, initSentry } = require('../shared/observability');
installBigIntJson();

const Sentry = initSentry('stays-api');

const cors = require('cors');
const express = require('express');
const helmet = require('helmet');
const hpp = require('hpp');
const morgan = require('morgan');
const compression = require('compression');
const crypto = require('crypto');

const { createLimiter } = require('../../middleware/dynamicRateLimiter');
const { captureRequestMeta } = require('../../middleware/requestMeta');
const globalErrorHandler = require('../../middleware/errorMiddleware');
const maintenanceMode = require('../../middleware/maintenanceMode');
const { protect } = require('../../middleware/authMiddleware');
const { resolveSupplier } = require('../../middleware/teamRoleMiddleware');
const { httpOrigins, isAllowedOrigin } = require('../../config/corsOrigins');
const {
  LEGACY_API_PREFIX,
  VERSIONED_API_PREFIX,
  normalizeWithinApi,
  tagApiVersion,
} = require('../../middleware/apiVersion');

const AppError = require('../../src/core/services/appError');
const prisma = require('../../src/core/services/prismaClient');
const redisClient = require('../../src/core/services/redisClient');
const logger = require('../../src/core/services/logger');

const staysRoutes = require('../../src/brands/ghana/staysRoutes');

const SERVICE_NAME = 'stays-api';

/**
 * The only path this application serves, relative to an API prefix. Both
 * prefixes append it, so the legacy and canonical URLs reach identical code.
 */
const STAYS_MOUNT_PATH = '/travioghana/supplier/stays';

function createLimiters() {
  return {
    // Same env keys as the Platform API (`RATELIMIT_GLOBAL_*`) so one knob
    // tunes both services. Counters are per process, as they should be.
    global: createLimiter({
      name: 'global',
      defaultMax: 500,
      defaultWindowMs: 60 * 60 * 1000,
      message: {
        status: 'fail',
        message: 'Too many requests from this IP, please try again later.',
      },
      skip: (req) => req.method === 'OPTIONS',
    }),
    // Photo/document uploads are multipart writes on this router. The Platform
    // app rate-limits supplier POST/PATCH; Stays lives in its own process and
    // must apply the same guard itself, not inherit it by accident.
    upload: createLimiter({
      name: 'upload',
      defaultMax: 20,
      defaultWindowMs: 60 * 60 * 1000,
      message: {
        status: 'fail',
        message: 'Too many uploads, please try again later.',
      },
    }),
  };
}

/** Mount the stays router (and its guards) under one API prefix. */
function mountStaysRoutes(app, prefix) {
  // `protect` then `resolveSupplier`: authenticate, then resolve the owning
  // supplier for an owner *or* an accepted team member. Matches the guard chain
  // the Platform app applies at supplierRoutes.js before `/stays`.
  app.use(
    `${prefix}${STAYS_MOUNT_PATH}`,
    protect,
    resolveSupplier,
    staysRoutes,
  );
}

function buildStaysApp({ prefixes = [LEGACY_API_PREFIX, VERSIONED_API_PREFIX] } = {}) {
  const app = express();

  app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        imgSrc: ["'self'", 'data:', 'https://res.cloudinary.com', 'https://*.cloudinary.com'],
        connectSrc: ["'self'", 'https://api.stripe.com', 'https://js.stripe.com', 'https://accounts.google.com'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'", 'https://accounts.google.com'],
        fontSrc: ["'self'"],
        frameSrc: ["https://accounts.google.com"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  }));
  app.use(hpp());
  app.use(captureRequestMeta);
  app.use((req, res, next) => {
    // Compression mangles multipart streams; the Platform app guards the same
    // way and uploads must behave identically on both services.
    if (req.headers['content-type']?.startsWith('multipart/')) return next();
    compression()(req, res, next);
  });

  // CORS before the limiter so a 429 still carries the CORS headers the
  // browser needs in order to surface the real status.
  app.use(cors({
    origin: function (origin, callback) {
      callback(null, isAllowedOrigin(origin, httpOrigins()));
    },
    credentials: true,
    exposedHeaders: ['Content-Disposition'],
  }));

  // Stamp the contract version before any limiter or router, so both a 429 and
  // a 200 say which contract answered.
  app.use(LEGACY_API_PREFIX, tagApiVersion);

  const limiters = createLimiters();

  // One prefix-wide limiter at `/api`. Express prefix matching already covers
  // `/api/v1/...`; mounting it twice would halve the real budget and charge
  // every canonical request twice.
  app.use(LEGACY_API_PREFIX, limiters.global);

  // Upload guard on the router's write verbs, per prefix. `/api/...stays` does
  // not prefix-match `/api/v1/...stays`, so it is registered for both.
  for (const prefix of prefixes) {
    app.use(`${prefix}${STAYS_MOUNT_PATH}`, (req, res, next) => {
      if (req.method === 'POST' || req.method === 'PATCH') {
        return limiters.upload(req, res, next);
      }
      next();
    });
  }

  // Correlation ID.
  app.use((req, res, next) => {
    req.id = crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
  });

  // Request monitoring.
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      logger.httpLog(req.method, req.originalUrl, res.statusCode, Date.now() - start, {
        reqId: req.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        service: SERVICE_NAME,
      });
    });
    next();
  });

  if (process.env.NODE_ENV === 'development') {
    app.use(morgan('dev'));
  }

  // `protect` accepts an `accessToken` cookie as well as a Bearer header, so
  // the cookie parser is required even though this app never sets cookies.
  app.use(require('cookie-parser')());

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // ── Probes ───────────────────────────────────────────────────────────────
  // Liveness: the process is up. Always 200 so a monitor can distinguish "the
  // container is dead" from "a dependency is down".
  app.get('/health', async (req, res) => {
    const checks = { database: 'unknown', redis: 'unknown' };

    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = 'healthy';
    } catch {
      checks.database = 'down';
    }

    try {
      checks.redis = (await redisClient.isRedisAvailable()) ? 'healthy' : 'unhealthy';
    } catch {
      checks.redis = 'down';
    }

    res.status(200).json({
      status: 'success',
      service: SERVICE_NAME,
      version: process.env.RELEASE_VERSION || 'dev',
      commit: process.env.RELEASE_COMMIT || null,
      checks,
    });
  });

  // Readiness: can this app serve traffic right now?
  //
  // Postgres is mandatory — every Stays read and write touches it. Redis is
  // optional here: the cache helper falls back to an in-process LRU, so a
  // Redis outage degrades performance but does not make Stays unable to serve.
  // Reporting it as a required failure would take Stays out of rotation for a
  // dependency it can live without.
  app.get('/ready', async (req, res) => {
    const checks = { database: 'unknown', redis: { status: 'unknown', required: false } };

    let dbOk = false;
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = 'healthy';
      dbOk = true;
    } catch {
      checks.database = 'down';
    }

    try {
      checks.redis.status = (await redisClient.isRedisAvailable()) ? 'healthy' : 'unhealthy';
    } catch {
      checks.redis.status = 'down';
    }

    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? 'ready' : 'not_ready',
      service: SERVICE_NAME,
      version: process.env.RELEASE_VERSION || 'dev',
      commit: process.env.RELEASE_COMMIT || null,
      checks,
    });
  });

  app.get('/', (req, res) => {
    res.send('Travio Africa Stays API is running...');
  });

  // Platform-wide maintenance switch. `/api` covers `/api/v1/...`; maintenanceMode
  // normalises the version segment so both spellings make the same decision.
  app.use(LEGACY_API_PREFIX, maintenanceMode);

  for (const prefix of prefixes) mountStaysRoutes(app, prefix);

  Sentry.setupExpressErrorHandler(app);

  app.use((req, res, next) => {
    next(new AppError(`Can't find ${req.originalUrl} on this server!`, 404));
  });

  app.use(globalErrorHandler);

  return app;
}

const app = buildStaysApp();

module.exports = app;
module.exports.buildStaysApp = buildStaysApp;
module.exports.mountStaysRoutes = mountStaysRoutes;
module.exports.STAYS_MOUNT_PATH = STAYS_MOUNT_PATH;
module.exports.normalizeWithinApi = normalizeWithinApi;
