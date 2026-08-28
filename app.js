// BigInt is not serializable by JSON.stringify by default.
// Prisma can return BigInt from raw SQL aggregates (COUNT, SUM).
// This polyfill prevents "Do not know how to serialize a BigInt" errors.
BigInt.prototype.toJSON = function () {
  return Number(this);
};

const Sentry = require('@sentry/node');

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
  ignoreErrors: [
    'Object [object Object] has no method',
  ],
});

const cors = require('cors');
const express = require('express');
const swaggerUi = require('swagger-ui-express');
const helmet = require('helmet');
const { createLimiter } = require('./middleware/dynamicRateLimiter');
const { captureRequestMeta } = require('./middleware/requestMeta');
const hpp = require('hpp');
const morgan = require('morgan');
const compression = require('compression');
const crypto = require('crypto');
const logger = require('./utils/logger');


const passport = require('./config/passport');
const globalErrorHandler = require('./middleware/errorMiddleware');
const AppError = require('./utils/appError');
const prisma = require('./utils/prismaClient');
const { isRedisAvailable } = require('./utils/queue');

const app = express();

// Trust Render proxy for correct IP detection (rate limiting, etc.)
app.set('trust proxy', 1);



let swaggerSpec;
try {
  swaggerSpec = require('./config/swagger');
} catch (e) {
  console.warn('Swagger spec generation failed:', e.message);
}

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

// CORS must be registered before rate limiter so that
// rate-limited responses include proper CORS headers.
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:5174', 'http://127.0.0.1:5174'];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(null, false);
  },
  credentials: true,
};

app.use(cors(corsOptions));

// Global rate limit: 500 requests per hour per IP (configurable via ratelimit.global)
app.use(
  '/api',
  createLimiter({
    name: 'global',
    defaultMax: 500,
    defaultWindowMs: 60 * 60 * 1000,
    message: {
      status: 'fail',
      message: 'Too many requests from this IP, please try again later.',
    },
  }),
);

// Stricter rate limit on auth endpoints
app.use(
  '/api/auth',
  createLimiter({
    name: 'auth',
    defaultMax: 20,
    defaultWindowMs: 15 * 60 * 1000,
    message: {
      status: 'fail',
      message: 'Too many auth attempts, please try again later.',
    },
  }),
);

// Stricter rate limit on file upload endpoints (20 uploads per hour per user)
const uploadLimiter = createLimiter({
  name: 'upload',
  defaultMax: 20,
  defaultWindowMs: 60 * 60 * 1000,
  message: {
    status: 'fail',
    message: 'Too many uploads, please try again later.',
  },
});
app.use('/api/users/updateMe', uploadLimiter);
app.use('/api/tours', (req, res, next) => {
  if (req.method === 'POST' || req.method === 'PATCH') return uploadLimiter(req, res, next);
  next();
});
app.use('/api/reviews', (req, res, next) => {
  if (req.method === 'POST' || req.method === 'PATCH') return uploadLimiter(req, res, next);
  next();
});
app.use('/api/suppliers', (req, res, next) => {
  if (['POST', 'PATCH'].includes(req.method)) return uploadLimiter(req, res, next);
  next();
});
app.use('/api/chat', (req, res, next) => {
  if (req.method === 'POST') return uploadLimiter(req, res, next);
  next();
});
app.use('/api/blog/admin/upload', uploadLimiter);

// Attach correlation ID to every request
app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
});

// Request monitoring middleware
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

// Dev-only detailed logging
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

app.use(passport.initialize());

app.use(require('cookie-parser')());
// Stripe webhook signature verification needs the RAW request body (a Buffer
// of the original bytes), so parse it BEFORE the global express.json() below
// consumes the stream. `express.json()` will then skip this path because the
// body was already parsed (body-parser sets req._body = true).
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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

  try {
    const redisOk = await isRedisAvailable();
    checks.redis = redisOk ? 'healthy' : 'unhealthy';
  } catch {
    checks.redis = 'down';
  }

  res.status(200).json({ status: dbOk ? 'success' : 'degraded', checks });
});


app.get('/', (req, res) => {
  res.send('Expedition Go Tours API is running...');
});

const userRoutes = require('./routes/userRoutes');
const tourRoutes = require('./routes/tourRoutes');
const bookingRoutes = require('./routes/bookingRoutes');
const reviewRoutes = require('./routes/reviewRoutes');
const supplierRoutes = require('./routes/supplierRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const payoutRoutes = require('./routes/payoutRoutes');
const payoutMethodRoutes = require('./routes/payoutMethodRoutes');
const financeRoutes = require('./routes/financeRoutes');
const adminFinanceRoutes = require('./routes/adminFinanceRoutes');
const disputeRoutes = require('./routes/disputeRoutes');
const chatRoutes = require('./routes/chatRoutes');
const availabilityRoutes = require('./routes/availabilityRoutes');
const adminSettingsRoutes = require('./routes/adminSettingsRoutes');
const adminSystemRoutes = require('./routes/adminSystemRoutes');
const adminRoleRoutes = require('./routes/adminRoleRoutes');
const adminUserRoutes = require('./routes/adminUserRoutes');
const supplierSettingsRoutes = require('./routes/supplierSettingsRoutes');
const specialOfferRoutes = require('./routes/specialOfferRoutes');
const locationRoutes = require('./routes/locationRoutes');
const keywordRoutes = require('./routes/keywordRoutes');
const expeditionRoutes = require('./routes/expeditionRoutes');
const travioGhanaRoutes = require('./routes/travioGhanaRoutes');
const travioGhanaAdminRoutes = require('./routes/travioGhanaAdminRoutes');
const blogRoutes = require('./routes/blogRoutes');
const mediaRoutes = require('./routes/mediaRoutes');
const homepageRoutes = require('./routes/homepageRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes');
const maintenanceMode = require('./middleware/maintenanceMode');

app.use('/api', maintenanceMode);

app.use('/api/users', userRoutes);
app.use('/api/tours', tourRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/suppliers', supplierRoutes);
app.use('/api/payouts', payoutRoutes);
app.use('/api/payout-methods', payoutMethodRoutes);
app.use('/api/finance', financeRoutes);
app.use('/api/admin/finance', adminFinanceRoutes);
app.use('/api/disputes', disputeRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin/settings', adminSettingsRoutes);
app.use('/api/admin/system', adminSystemRoutes);
app.use('/api/admin/roles', adminRoleRoutes);
app.use('/api/admin/admins', adminUserRoutes);
app.use('/api/tours', availabilityRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/suppliers/settings', supplierSettingsRoutes);
app.use('/api/suppliers/special-offers', specialOfferRoutes);
app.use('/api/locations', locationRoutes);
app.use('/api/keywords', keywordRoutes);
app.use('/api/expedition', expeditionRoutes);
app.use('/api/travioghana', travioGhanaRoutes);
app.use('/api/travioghana/admin', travioGhanaAdminRoutes);
app.use('/api/blog', blogRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/homepage', homepageRoutes);
app.use('/api/analytics', analyticsRoutes);


if (swaggerSpec && process.env.NODE_ENV !== 'production') {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  app.get('/swagger.json', (req, res) => {
    res.json(swaggerSpec);
  });
}

Sentry.setupExpressErrorHandler(app);

app.use((req, res, next) => {
  next(new AppError(`Can't find ${req.originalUrl} on this server!`, 404));
});

app.use(globalErrorHandler);

module.exports = app;
