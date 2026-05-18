# Expedition Go Backend v2

Production-ready tour booking platform backend built with Node.js, Express, Prisma ORM, PostgreSQL (PostGIS), Firebase Authentication, and Stripe Connect.

## Features

- **Multi-role Authentication**: Customer, Supplier, and Admin roles with Firebase token verification
- **Tour Management**: Full CRUD with rich metadata, PostGIS geo-search, categorization, and pagination
- **Booking System**: Full lifecycle with conflict detection, Stripe Payment Intent integration, and commission splits
- **Review System**: Customer reviews with moderation, supplier responses, and rating aggregation
- **Supplier Onboarding**: Application workflow with Stripe Connect Express account creation
- **Notifications**: Real-time (Socket.IO), email (SendGrid), and in-app notification service
- **Payment Processing**: Stripe Connect with automatic commission splits and payout management
- **Image Management**: Cloudinary upload with optimization pipeline
- **Redis Caching**: Tour detail and filter caching with automatic invalidation
- **Audit Logging**: Comprehensive action logging for admin monitoring
- **API Documentation**: Swagger/OpenAPI at `/api-docs`

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20 |
| Framework | Express |
| Database | PostgreSQL 16 + PostGIS |
| ORM | Prisma |
| Auth | Firebase Admin SDK |
| Payments | Stripe Connect |
| Email | SendGrid |
| Media | Cloudinary |
| Cache | Redis (ioredis) |
| Realtime | Socket.IO |
| Logging | Structured JSON logger (Logtail) |

## Prerequisites

- Node.js 20 or higher
- PostgreSQL 16 with PostGIS extension
- Firebase project with Admin SDK service account
- Stripe account with Connect enabled
- Cloudinary account
- Redis instance (optional, falls back gracefully)
- SendGrid account (optional, falls back gracefully)

## Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/Expedition-Go-Tours/Expedition-Go-Backend-v2.git
   cd Expedition-Go-Backend-v2
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**

   Create a `.env` file in the root directory. All third-party SDKs use lazy initialization and degrade gracefully when their keys are missing (except Firebase in production).

   ```env
   # Database
   DATABASE_URL=postgresql://user:password@localhost:5432/expedition_go
   DIRECT_URL=postgresql://user:password@localhost:5432/expedition_go

   # Server
   PORT=5000
   NODE_ENV=development

   # Firebase Admin SDK
   FIREBASE_PROJECT_ID=your_project_id
   FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
   FIREBASE_CLIENT_EMAIL=firebase-adminsdk@your-project.iam.gserviceaccount.com

   # Stripe
   STRIPE_SECRET_KEY=sk_test_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   STRIPE_COMMISSION_RATE=0.15

   # Cloudinary
   CLOUDINARY_CLOUD_NAME=your_cloud_name
   CLOUDINARY_API_KEY=your_api_key
   CLOUDINARY_API_SECRET=your_api_secret

   # Redis
   REDIS_URL=redis://localhost:6379

   # SendGrid
   SENDGRID_API_KEY=SG....
   EMAIL_FROM="Travio Africa <noreply@travioafrica.com>"
   ```

4. **Run database migrations**
   ```bash
   npx prisma migrate deploy
   ```

5. **Generate Prisma Client**
   ```bash
   npx prisma generate
   ```

6. **Start the server**
   ```bash
   npm start
   ```

   The server starts at `http://localhost:5000`.

## API Documentation

Once the server is running:
- **Swagger UI**: `http://localhost:5000/api-docs`
- **OpenAPI Spec**: `http://localhost:5000/api-docs.json`

## Authentication

This backend uses Firebase Authentication with custom token verification. Firebase Admin SDK runs in stubbed mode when `NODE_ENV=development` or when credentials are absent, allowing local development without real Firebase credentials.

### Authentication Flow

1. User authenticates with Firebase on the frontend
2. Frontend retrieves Firebase ID token
3. Frontend calls `POST /api/users/signup` with the token in the `Authorization` header
4. Backend verifies the token and creates or retrieves the user from the database
5. Subsequent API calls include the Firebase token: `Authorization: Bearer <token>`

### Example

```javascript
const response = await fetch('http://localhost:5000/api/users/me', {
  headers: {
    'Authorization': `Bearer ${firebaseIdToken}`
  }
});
```

## Project Structure

```
├── config/              # Firebase, Cloudinary, Swagger configuration
├── controllers/         # Route handlers with business logic
├── middleware/          # Auth, error handling, file upload
├── prisma/              # Schema, migrations, PostGIS extensions
├── routes/              # Express route definitions
├── utils/               # Helpers: Stripe, email, cache, logger, notifications
├── __tests__/           # Test suites (unit, integration, API)
├── .github/workflows/   # CI/CD pipeline
├── app.js               # Express application setup
├── server.js            # Entry point with graceful shutdown
└── package.json
```

## Key Endpoints

### Authentication
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/users/signup` | Create or get user profile (idempotent) |
| PATCH | `/api/users/sync-me` | Sync user profile with Firebase |
| GET | `/api/users/me` | Get current user profile |

### Tours
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tours` | List tours (pagination, filters, geo-search) |
| GET | `/api/tours/:id` | Get tour details |
| POST | `/api/tours` | Create tour (supplier only) |
| PATCH | `/api/tours/:id` | Update tour (supplier only) |

### Bookings
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/bookings` | Create booking with Stripe payment |
| GET | `/api/bookings/my-bookings` | List current user's bookings |
| PATCH | `/api/bookings/:id/cancel` | Cancel booking |

### Reviews
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/reviews` | Submit review |
| GET | `/api/reviews/tour/:tourId` | Get tour reviews |
| PATCH | `/api/reviews/:id/respond` | Supplier response |

### Suppliers
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/suppliers/apply` | Submit supplier application |
| GET | `/api/suppliers/dashboard` | Supplier dashboard |
| GET | `/api/suppliers/admin/applications` | Admin: view applications |

## Testing

The project includes 11 tests across 4 suites with Jest + Supertest, validated in CI against a fresh PostgreSQL container.

```bash
# Run all tests
npm test

# Run with coverage report
npx jest --coverage
```

### Test Suites

| Suite | File | Type | Coverage |
|-------|------|------|----------|
| AppError | `__tests__/appError.test.js` | Unit | Error class behavior |
| User CRUD | `__tests__/user.integration.test.js` | Integration | Prisma + PostgreSQL |
| Health | `__tests__/api/health.test.js` | API | Server availability |
| Tours | `__tests__/api/tours.test.js` | API | Pagination, validation |

### Coverage Thresholds

- Branches: 3%
- Functions: 5%
- Lines: 10%
- Statements: 10%

## CI/CD Pipeline

A three-stage GitHub Actions pipeline runs on every push to `main` and `develop`:

1. **Lint** -- ESLint with Node.js + Jest globals
2. **Test** -- Against a temporary PostGIS 16 container with `prisma migrate deploy`
3. **Deploy** -- Triggers Render deploy hook (main branch only, gated on test success)

Configuration: `.github/workflows/ci.yml`

### Required GitHub Secret

| Secret | Purpose |
|--------|---------|
| `RENDER_DEPLOY_HOOK` | URL for triggering Render deployment |

All third-party SDKs (Stripe, SendGrid, Firebase, Redis, Cloudinary) gracefully degrade in CI without their environment keys.

## Development

```bash
# Auto-reload with nodemon
npm run dev

# Create a new Prisma migration
npx prisma migrate dev --name migration_name

# Reset database (deletes all data)
npx prisma migrate reset

# Open Prisma Studio (database GUI)
npx prisma studio
```

## Deployment

### Environment Variables

Set all production values on your hosting platform. Firebase Admin SDK requires real service account credentials in production (`NODE_ENV=production`).

### Database Migration

```bash
npx prisma migrate deploy
```

### Start

```bash
npm start
```

The app runs on the port defined by the `PORT` environment variable (default: 5000).

## Security

- Firebase token verification on all protected routes
- Role-based access control (Customer, Supplier, Admin)
- Input validation and sanitization on all endpoints
- SQL injection prevention via Prisma parameterized queries
- Stripe webhook signature verification
- CORS with allowed origin validation
- Structured error handling (no stack traces leaked in production)
- Graceful shutdown with pending request draining

## SDG Contribution

This project supports UN Sustainable Development Goal 8 (Decent Work and Economic Growth) by enabling local tour operators and guides to list and manage their offerings on a digital platform, expanding their market reach beyond traditional channels.

## License

Proprietary and confidential.

---

**Last Updated**: May 18, 2026
**Version**: 2.1.0
