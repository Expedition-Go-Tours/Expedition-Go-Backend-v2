/**
 * Platform API — composition root.
 *
 * Owns Tours, tour availability and bookings, Expedition, the shared platform
 * surface (auth, users, suppliers, finance, payouts, refunds, notifications,
 * chat, media, admin, prerender) and every background worker and scheduler.
 *
 * The Stays application (`apps/stays-api`) is a second composition root. It
 * mounts the accommodation supplier router and nothing else. Both bootstraps
 * read the same Prisma schema and reuse the same shared modules — they are
 * separate processes, not separate services with duplicated code.
 *
 * Two prefixes, one implementation
 * --------------------------------
 * `buildPlatformApp()` mounts every router twice: once under `/api` (legacy,
 * what every existing client calls) and once under `/api/v1` (canonical).
 * See `middleware/apiVersion.js` for the rules that keep them equivalent.
 *
 * `buildPlatformApp` is exported for tests that need an app with a narrowed
 * prefix list. The default export of this module is a ready instance, which
 * is what `app.js` at the repository root re-exports so all existing tests
 * and PM2's `script: 'server.js'` keep working unchanged.
 */

// BigInt is not serializable by JSON.stringify by default.
// Prisma can return BigInt from raw SQL aggregates (COUNT, SUM). This polyfill
// prevents "Do not know how to serialize a BigInt" errors. Shared with the
// Stays app so both processes behave identically.
const { installBigIntJson, initSentry } = require('../shared/observability');
installBigIntJson();

const Sentry = initSentry('platform-api');

const cors = require('cors');
const express = require('express');
const swaggerUi = require('swagger-ui-express');
const helmet = require('helmet');
const { createLimiter } = require('../../middleware/dynamicRateLimiter');
const { captureRequestMeta } = require('../../middleware/requestMeta');
const hpp = require('hpp');
const morgan = require('morgan');
const compression = require('compression');
const crypto = require('crypto');
const logger = require('../../src/core/services/logger');

const passport = require('../../config/passport');
const { httpOrigins, isAllowedOrigin } = require('../../config/corsOrigins');
const globalErrorHandler = require('../../middleware/errorMiddleware');
const AppError = require('../../src/core/services/appError');
const prisma = require('../../src/core/services/prismaClient');
const { isRedisAvailable } = require('../../src/core/services/queue');
const {
  LEGACY_API_PREFIX,
  VERSIONED_API_PREFIX,
  normalizeWithinApi,
  tagApiVersion,
} = require('../../middleware/apiVersion');
const maintenanceMode = require('../../middleware/maintenanceMode');
const { attachBrand } = require('../../middleware/brandContext');

// ── Routers ────────────────────────────────────────────────────────────────
const userRoutes = require('../../routes/userRoutes');
const tourRoutes = require('../../routes/tourRoutes');
const bookingRoutes = require('../../routes/bookingRoutes');
const reviewRoutes = require('../../routes/reviewRoutes');
const supplierRoutes = require('../../routes/supplierRoutes');
const notificationRoutes = require('../../routes/notificationRoutes');
const webhookRoutes = require('../../routes/webhookRoutes');
const authRoutes = require('../../routes/authRoutes');
const ssoRoutes = require('../../routes/ssoRoutes');
const adminRoutes = require('../../routes/adminRoutes');
const adminEmailPreviewRoutes = require('../../routes/adminEmailPreviewRoutes');
const externalReviewRoutes = require('../../routes/externalReviewRoutes');
const payoutRoutes = require('../../routes/payoutRoutes');
const payoutMethodRoutes = require('../../routes/payoutMethodRoutes');
const financeRoutes = require('../../routes/financeRoutes');
const adminFinanceRoutes = require('../../routes/adminFinanceRoutes');
const disputeRoutes = require('../../routes/disputeRoutes');
const refundClaimRoutes = require('../../routes/refundClaimRoutes');
const emailInboundRoutes = require('../../routes/emailInboundRoutes');
const emailWebhookRoutes = require('../../routes/emailWebhookRoutes');
const chatRoutes = require('../../routes/chatRoutes');
const availabilityRoutes = require('../../routes/availabilityRoutes');
const adminSettingsRoutes = require('../../routes/adminSettingsRoutes');
const adminSystemRoutes = require('../../routes/adminSystemRoutes');
const adminRoleRoutes = require('../../routes/adminRoleRoutes');
const adminUserRoutes = require('../../routes/adminUserRoutes');
const supplierSettingsRoutes = require('../../routes/supplierSettingsRoutes');
const specialOfferRoutes = require('../../routes/specialOfferRoutes');
const locationRoutes = require('../../routes/locationRoutes');
const placeRoutes = require('../../routes/placeRoutes');
const searchRoutes = require('../../routes/searchRoutes');
const keywordRoutes = require('../../routes/keywordRoutes');
const expeditionRoutes = require('../../src/brands/expedition/routes');
const travioGhanaRoutes = require('../../src/brands/ghana/routes');
const travioGhanaAdminRoutes = require('../../src/brands/ghana/adminRoutes');
const travioGhanaSupplierRoutes = require('../../src/brands/ghana/supplierRoutes');
const travioAfricaRoutes = require('../../src/brands/africa/routes');
const travioAfricaSupplierRoutes = require('../../src/brands/africa/supplierRoutes');
const travioAfricaAdminRoutes = require('../../src/brands/africa/adminRoutes');
const blogRoutes = require('../../routes/blogRoutes');
const mediaRoutes = require('../../routes/mediaRoutes');
const homepageRoutes = require('../../routes/homepageRoutes');
const consentRoutes = require('../../routes/consentRoutes');
const analyticsRoutes = require('../../routes/analyticsRoutes');
const { prerender } = require('../../src/core/domain/prerenderController');

/**
 * Build one limiter set per application, not per prefix.
 *
 * express-rate-limit keeps its counters inside the middleware instance, so
 * sharing one instance across both prefixes is what makes `/api` and
 * `/api/v1` draw from the same budget. Building two sets would let a caller
 * double their allowance simply by alternating prefixes.
 */
function createLimiters() {
  return {
    // Bots crawl every storefront URL from a small shared IP pool, so the
    // prerender endpoint gets its own generous budget — otherwise Googlebot is
    // handed JSON 429 halfway through a crawl and the sitemap entries behind it
    // stay unindexed. Build-time sitemap reads are one-shots and are skipped by
    // the global limiter below.
    prerender: createLimiter({
      name: 'prerender',
      defaultMax: 3000,
      defaultWindowMs: 60 * 60 * 1000,
      message: {
        status: 'fail',
        message: 'Too many prerender requests from this IP, please try again later.',
      },
    }),
    // Global: 500 requests per hour per IP (configurable via ratelimit.global).
    global: createLimiter({
      name: 'global',
      defaultMax: 500,
      defaultWindowMs: 60 * 60 * 1000,
      message: {
        status: 'fail',
        message: 'Too many requests from this IP, please try again later.',
      },
      // Mounted at `/api`, so this path is relative to that mount and carries
      // the `/v1` segment for canonical calls. Normalising keeps the skip
      // decision identical for both prefixes.
      skip: (req) => {
        if (req.method === 'OPTIONS') return true;
        const path = normalizeWithinApi(req.path);
        return (
          path === '/prerender' ||
          path.endsWith('/sitemap') ||
          // The email-preview gallery frames one request per template on load,
          // so it would burn the shared budget in a few refreshes. It is gated
          // by a short-lived signed token instead (brute force is infeasible).
          path.startsWith('/admin/email-previews')
        );
      },
    }),
    // Stricter limit on credential endpoints.
    auth: createLimiter({
      name: 'auth',
      defaultMax: 20,
      defaultWindowMs: 15 * 60 * 1000,
      message: {
        status: 'fail',
        message: 'Too many auth attempts, please try again later.',
      },
    }),
    // Place lookups can hit the geocoder on a cache miss — cap them per IP.
    places: createLimiter({
      name: 'places',
      defaultMax: 120,
      defaultWindowMs: 60 * 1000,
      message: {
        status: 'fail',
        message: 'Too many place lookups, please slow down.',
      },
    }),
    // File uploads: 20 per hour per user.
    upload: createLimiter({
      name: 'upload',
      defaultMax: 20,
      defaultWindowMs: 60 * 60 * 1000,
      message: {
        status: 'fail',
        message: 'Too many uploads, please try again later.',
      },
    }),
    // Cross-storefront handoff. Its own limiter rather than the /auth one:
    // minting happens during ordinary browsing (prefetch before a tour click), so
    // folding it into the credential-attempt budget would let normal use exhaust
    // the login allowance for everyone behind one IP.
    //
    // One instance, shared by both prefixes. Creating it inside
    // `mountPrefixRoutes` (as this used to) gave each prefix its own counter and
    // therefore twice the intended budget for the same person.
    sso: createLimiter({
      name: 'sso',
      defaultMax: 120,
      defaultWindowMs: 15 * 60 * 1000,
      message: {
        status: 'fail',
        message: 'Too many sign-in handoffs, please try again shortly.',
      },
    }),
  };
}

/** Apply the upload limiter only to writes — reads on these paths stay cheap. */
function onWrite(limiter) {
  return (req, res, next) => {
    if (req.method === 'POST' || req.method === 'PATCH') return limiter(req, res, next);
    next();
  };
}

/**
 * Path-scoped middleware for one API prefix.
 *
 * Every entry here must exist for BOTH prefixes. A limiter that guards only
 * the legacy path is not a guard: it is a documented bypass for anyone who
 * adds `/v1`. Consistency is asserted by
 * `__tests__/api/apiVersioning.test.js`.
 */
function applyPrefixMiddleware(app, prefix, limiters) {
  app.use(`${prefix}/prerender`, limiters.prerender);
  app.use(`${prefix}/auth`, limiters.auth);
  app.use(`${prefix}/places`, limiters.places);
  app.use(`${prefix}/users/updateMe`, limiters.upload);
  app.use(`${prefix}/tours`, onWrite(limiters.upload));
  app.use(`${prefix}/reviews`, onWrite(limiters.upload));
  app.use(
    `${prefix}/suppliers`,
    (req, res, next) => (['POST', 'PATCH'].includes(req.method) ? limiters.upload(req, res, next) : next()),
  );
  app.use(
    `${prefix}/chat`,
    (req, res, next) => (req.method === 'POST' ? limiters.upload(req, res, next) : next()),
  );
  app.use(`${prefix}/blog/admin/upload`, limiters.upload);
}

/**
 * Mount every platform router under one prefix.
 *
 * Ordering is load-bearing and is preserved exactly as it was before the
 * extraction — several comment blocks below explain why a specific router must
 * precede a broader one.
 */
function mountPrefixRoutes(app, prefix, limiters) {
  app.use(`${prefix}/users`, userRoutes);
  app.use(`${prefix}/tours`, tourRoutes);
  app.use(`${prefix}/bookings`, bookingRoutes);
  app.use(`${prefix}/reviews`, reviewRoutes);
  // Mount the more specific settings router BEFORE the general `/suppliers`
  // router. supplierRoutes applies `protect` globally, which would otherwise
  // shadow the public (token-authenticated) endpoints under /settings — the
  // notification-email confirmation link and the team-invite lookup.
  app.use(`${prefix}/suppliers/settings`, supplierSettingsRoutes);
  app.use(`${prefix}/suppliers`, supplierRoutes);
  app.use(`${prefix}/payouts`, payoutRoutes);
  app.use(`${prefix}/payout-methods`, payoutMethodRoutes);
  app.use(`${prefix}/finance`, financeRoutes);
  app.use(`${prefix}/admin/finance`, adminFinanceRoutes);
  app.use(`${prefix}/disputes`, disputeRoutes);
  app.use(`${prefix}/refund-claims`, refundClaimRoutes);
  app.use(`${prefix}/email/inbound`, emailInboundRoutes);
  app.use(`${prefix}/email/webhook`, emailWebhookRoutes);
  app.use(`${prefix}/notifications`, notificationRoutes);
  app.use(`${prefix}/webhooks`, webhookRoutes);
  app.use(`${prefix}/auth`, authRoutes);
  // Cross-storefront handoff, on the shared limiter instance (see
  // createLimiters) so both prefixes draw from one budget.
  app.use(`${prefix}/sso`, limiters.sso, ssoRoutes);
  // Machine-to-machine external-reviews sync — mounted BEFORE the admin router
  // so it is guarded by a service token, not the admin JWT/session middleware.
  app.use(`${prefix}/admin/external-reviews`, externalReviewRoutes);
  // Email preview gallery — read routes are gated by a short-lived signed token
  // (opened in a plain browser), so it must precede the admin router's global
  // protect(). The token is minted by POST /admin/email-previews/link, which
  // carries its own admin auth.
  app.use(`${prefix}/admin/email-previews`, adminEmailPreviewRoutes);
  app.use(`${prefix}/admin`, adminRoutes);
  app.use(`${prefix}/admin/settings`, adminSettingsRoutes);
  app.use(`${prefix}/admin/system`, adminSystemRoutes);
  app.use(`${prefix}/admin/roles`, adminRoleRoutes);
  app.use(`${prefix}/admin/admins`, adminUserRoutes);
  app.use(`${prefix}/tours`, availabilityRoutes);
  app.use(`${prefix}/chat`, chatRoutes);
  // Brand-scoped chat: the route carries the platform, so shared chat
  // controllers can stamp/scope conversations per brand. The shared mount above
  // stays for suppliers and as the legacy fallback.
  app.use(`${prefix}/travioghana/chat`, attachBrand('ghana'), chatRoutes);
  app.use(`${prefix}/travioafrica/chat`, attachBrand('africa'), chatRoutes);
  // The Expedition storefront is Ghana's sub-store, so its chat is Ghana-scoped.
  app.use(`${prefix}/expedition/chat`, attachBrand('ghana'), chatRoutes);
  app.use(`${prefix}/suppliers/special-offers`, specialOfferRoutes);
  app.use(`${prefix}/locations`, locationRoutes);
  app.use(`${prefix}/places`, placeRoutes);
  app.use(`${prefix}/search`, searchRoutes);
  app.use(`${prefix}/keywords`, keywordRoutes);
  app.use(`${prefix}/expedition`, expeditionRoutes);
  app.use(`${prefix}/travioghana`, travioGhanaRoutes);
  app.use(`${prefix}/travioghana/admin`, travioGhanaAdminRoutes);
  app.use(`${prefix}/travioghana/supplier`, travioGhanaSupplierRoutes);
  app.use(`${prefix}/travioafrica`, travioAfricaRoutes);
  app.use(`${prefix}/travioafrica/admin`, travioAfricaAdminRoutes);
  app.use(`${prefix}/travioafrica/supplier`, travioAfricaSupplierRoutes);
  app.use(`${prefix}/blog`, blogRoutes);
  app.use(`${prefix}/media`, mediaRoutes);
  app.use(`${prefix}/homepage`, homepageRoutes);
  app.use(`${prefix}/consent`, consentRoutes);
  app.use(`${prefix}/analytics`, analyticsRoutes);

  // SEO prerender — serves pre-rendered HTML with meta tags + JSON-LD to bots.
  // The Vercel Edge Middleware proxies bot requests to /api/prerender?url=...
  app.get(`${prefix}/prerender`, prerender);
}

function buildPlatformApp({ prefixes = [LEGACY_API_PREFIX, VERSIONED_API_PREFIX] } = {}) {
  const app = express();

  // Trust the reverse proxy for correct IP detection (rate limiting, etc.).
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
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  }));
  app.use(hpp());
  app.use(captureRequestMeta);
  app.use((req, res, next) => {
    if (req.headers['content-type']?.startsWith('multipart/')) return next();
    compression()(req, res, next);
  });

  // CORS must be registered before the rate limiter so that rate-limited
  // responses include proper CORS headers.
  const corsOptions = {
    origin: function (origin, callback) {
      callback(null, isAllowedOrigin(origin, httpOrigins()));
    },
    credentials: true,
    // `Content-Disposition` is not a CORS-safelisted response header, so a
    // cross-origin fetch cannot read it unless it is exposed. Without this the
    // CSV export fell back to a client-generated filename and ignored the name
    // the server chose.
    exposedHeaders: ['Content-Disposition'],
  };

  app.use(cors(corsOptions));

  // Version stamping sits before every limiter and router so a 429 and a 200
  // both say which contract answered.
  app.use(LEGACY_API_PREFIX, tagApiVersion);

  const limiters = createLimiters();

  // ONE global limiter and ONE maintenance gate, mounted once at `/api`.
  //
  // Both are prefix-wide, and Express prefix matching means `/api` already
  // covers `/api/v1/...`. Mounting them a second time under the canonical
  // prefix would charge each v1 request twice (halving the real budget) and
  // evaluate the maintenance flag twice. Route-scoped middleware below is
  // different: `/api/auth` does not match `/api/v1/auth`, so those are mounted
  // per prefix.
  //
  // The mount path also keeps `/health`, `/ready` and `/` outside the budget:
  // a monitor must never be rate-limited into reporting an outage.
  app.use(LEGACY_API_PREFIX, limiters.global);

  // Path-scoped limits, per prefix. Deliberately mounted BEFORE the body
  // parsers: an over-quota upload must be rejected without first buffering up
  // to 10 MB of it into memory. The `/api`-wide limiter above does not cover
  // these paths for the canonical prefix, so both prefixes are registered
  // explicitly — a limiter that guards only one spelling of a URL is not a
  // limiter, it is a documented bypass.
  for (const prefix of prefixes) applyPrefixMiddleware(app, prefix, limiters);

  // Attach correlation ID to every request.
  app.use((req, res, next) => {
    req.id = crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
  });

  // Request monitoring middleware.
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      logger.httpLog(req.method, req.originalUrl, res.statusCode, duration, {
        reqId: req.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
    });
    next();
  });

  // Dev-only detailed logging.
  if (process.env.NODE_ENV === 'development') {
    app.use(morgan('dev'));
  }

  app.use(passport.initialize());
  app.use(require('cookie-parser')());

  // Webhook signature verification needs the RAW request body (a Buffer of the
  // original bytes), so parse it BEFORE the global express.json() below
  // consumes the stream. Both prefixes get the raw parser — a canonical webhook
  // URL must verify exactly like the legacy one, and Stripe is configured to
  // the legacy URL today, so neither may regress.
  for (const prefix of prefixes) {
    app.use(`${prefix}/webhooks/stripe`, express.raw({ type: 'application/json' }));
    // PayPal verification is an API round trip over the received event, so the
    // raw bytes and content-type must survive until the handler parses them.
    app.use(`${prefix}/webhooks/paypal`, express.raw({ type: '*/*' }));
    // Match ANY content-type so the raw bytes are always preserved — a
    // parsed-then-stringified body breaks Svix HMAC verification, and senders
    // are not guaranteed to use application/json (Resend docs warn about this).
    app.use(`${prefix}/email/inbound`, express.raw({ type: '*/*' }));
    app.use(`${prefix}/email/webhook`, express.raw({ type: '*/*' }));
  }
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // ── Probes ───────────────────────────────────────────────────────────────
  // Liveness: 200 while the process is alive, even if a dependency is down.
  app.get('/health', async (req, res) => {
    const checks = { database: 'unknown', redis: 'unknown' };
    let dbOk = false;

    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = 'healthy';
      dbOk = true;
    } catch {
      checks.database = 'down';
    }

    let redisOk = false;
    try {
      redisOk = await isRedisAvailable();
      checks.redis = redisOk ? 'healthy' : 'unhealthy';
    } catch {
      checks.redis = 'down';
    }

    const body = {
      status: dbOk ? 'success' : 'degraded',
      service: 'platform-api',
      version: process.env.RELEASE_VERSION || 'dev',
      commit: process.env.RELEASE_COMMIT || null,
      checks,
    };

    // Job-scheduler health (BullMQ): registration + execution. Only meaningful
    // when Redis is up; reported as 'unknown' otherwise so uptime checks don't
    // go red during a transient Redis blip.
    if (redisOk) {
      try {
        const { getSchedulerHealth } = require('../../src/core/services/queue');
        body.scheduler = await getSchedulerHealth();
      } catch (err) {
        // A health endpoint that hides its own failure reports "unknown" forever
        // with nothing in the logs to explain it.
        console.warn(`[Health] scheduler check failed: ${err?.message || err}`);
        body.scheduler = { status: 'unknown', error: err?.message || String(err) };
      }
    } else {
      body.scheduler = { status: 'unknown', reason: 'redis_down' };
    }

    res.status(200).json(body);
  });

  // Readiness: 200 only when this app can actually serve traffic.
  app.get('/ready', async (req, res) => {
    const checks = { database: 'unknown', redis: 'unknown' };
    let dbOk = false;
    let redisOk = false;

    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = 'healthy';
      dbOk = true;
    } catch {
      checks.database = 'down';
    }

    try {
      redisOk = await isRedisAvailable();
      checks.redis = redisOk ? 'healthy' : 'unhealthy';
    } catch {
      checks.redis = 'down';
    }

    const ready = dbOk && redisOk;
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      service: 'platform-api',
      checks,
    });
  });

  app.get('/', (req, res) => {
    res.send('TravioAfrica API is running...');
  });

  // Maintenance mode — prefix-wide, mounted once (see the note above).
  app.use(LEGACY_API_PREFIX, maintenanceMode);

  // Routers, per prefix.
  for (const prefix of prefixes) mountPrefixRoutes(app, prefix, limiters);

  if (process.env.NODE_ENV !== 'production') {
    let swaggerSpec;
    try {
      swaggerSpec = require('../../config/swagger');
    } catch (e) {
      console.warn('Swagger spec generation failed:', e.message);
    }
    if (swaggerSpec) {
      app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
      app.get('/swagger.json', (req, res) => {
        res.json(swaggerSpec);
      });
    }
  }

  Sentry.setupExpressErrorHandler(app);

  app.use((req, res, next) => {
    next(new AppError(`Can't find ${req.originalUrl} on this server!`, 404));
  });

  app.use(globalErrorHandler);

  return app;
}

const app = buildPlatformApp();

module.exports = app;
module.exports.buildPlatformApp = buildPlatformApp;
module.exports.mountPrefixRoutes = mountPrefixRoutes;
module.exports.applyPrefixMiddleware = applyPrefixMiddleware;
module.exports.createLimiters = createLimiters;
