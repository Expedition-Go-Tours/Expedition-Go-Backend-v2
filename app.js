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
const rateLimit = require('express-rate-limit');
const hpp = require('hpp');
const morgan = require('morgan');
const compression = require('compression');
const logger = require('./utils/logger');


const passport = require('./config/passport');
const globalErrorHandler = require('./middleware/errorMiddleware');
const AppError = require('./utils/appError');

const app = express();

// Trust Render proxy for correct IP detection (rate limiting, etc.)
app.set('trust proxy', 1);



let swaggerSpec;
try {
  swaggerSpec = require('./config/swagger');
} catch (e) {
  console.warn('Swagger spec generation failed:', e.message);
}

app.use(helmet());
app.use(hpp());
app.use(compression());

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
    callback(null, origin);
  },
  credentials: true,
};

app.use(cors(corsOptions));

// Global rate limit: 500 requests per hour per IP
app.use(
  '/api',
  rateLimit({
    max: 500,
    windowMs: 60 * 60 * 1000,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === 'OPTIONS',
    message: {
      status: 'fail',
      message: 'Too many requests from this IP, please try again later.',
    },
  }),
);

// Stricter rate limit on auth endpoints
app.use(
  '/api/auth',
  rateLimit({
    max: 20,
    windowMs: 15 * 60 * 1000,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === 'OPTIONS',
    message: {
      status: 'fail',
      message: 'Too many auth attempts, please try again later.',
    },
  }),
);

// Request monitoring middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.httpLog(req.method, req.originalUrl, res.statusCode, duration, {
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

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'API is healthy',
  });
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
const chatRoutes = require('./routes/chatRoutes');
const availabilityRoutes = require('./routes/availabilityRoutes');
const adminSettingsRoutes = require('./routes/adminSettingsRoutes');
const adminSystemRoutes = require('./routes/adminSystemRoutes');
const adminRoleRoutes = require('./routes/adminRoleRoutes');
const adminUserRoutes = require('./routes/adminUserRoutes');
const supplierSettingsRoutes = require('./routes/supplierSettingsRoutes');
const maintenanceMode = require('./middleware/maintenanceMode');

app.use('/api', maintenanceMode);

app.use('/api/users', userRoutes);
app.use('/api/tours', tourRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/suppliers', supplierRoutes);
app.use('/api/payouts', payoutRoutes);
app.use('/api/payout-methods', payoutMethodRoutes);
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


if (swaggerSpec) {
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

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION', err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION', err);
  process.exit(1);
});

module.exports = app;
