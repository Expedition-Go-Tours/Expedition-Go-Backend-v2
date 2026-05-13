const cors = require('cors');
const express = require('express');
const swaggerUi = require('swagger-ui-express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const hpp = require('hpp');
const morgan = require('morgan');
const compression = require('compression');
const cookieParser = require('cookie-parser');


const globalErrorHandler = require('./middleware/errorMiddleware');
const AppError = require('./utils/appError');

const app = express();

let swaggerSpec;
if (process.env.NODE_ENV === 'development') {
  swaggerSpec = require('./config/swagger');
}

app.use(helmet());
app.use(hpp());
app.use(compression());
app.use(cookieParser());

app.use(
  '/api',
  rateLimit({
    max: 100,
    windowMs: 15 * 60 * 1000,
    message: 'Too many requests from this IP, please try again later.',
  }),
);


const allowedOrigins = [
  'https://expedition-go-frontend.vercel.app',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'http://127.0.0.1:5175',
  'https://travioafrica.com',
  'https://supplier.travioafrica.com',
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(null, false);
  },
  credentials: true,
};

app.use(cors(corsOptions));

if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

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

app.use('/api/users', userRoutes);
app.use('/api/tours', tourRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/suppliers', supplierRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/auth', authRoutes);


if (process.env.NODE_ENV === 'development' && swaggerSpec) {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  app.get('/swagger.json', (req, res) => {
    res.json(swaggerSpec);
  });
}

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
