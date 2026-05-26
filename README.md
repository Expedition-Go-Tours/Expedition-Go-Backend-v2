# Expedition Go Backend v2

Production-ready tour booking platform backend built with Node.js, Express, Prisma ORM, PostgreSQL (PostGIS), Firebase Authentication, and Stripe.

## Features

- **Multi-role Authentication**: Customer, Supplier, and Admin roles with Firebase token verification
- **Tour Management**: Full CRUD with rich metadata, PostGIS geo-search, categorization, and pagination
- **Booking System**: Full lifecycle with conflict detection, Stripe Payment Intent integration, and commission splits
- **Review System**: Customer reviews with moderation, supplier responses, and rating aggregation
- **Supplier Onboarding**: Application workflow with document upload, admin review, and payout method setup
- **Notifications**: Real-time (Socket.IO), email (SendGrid), and in-app notification service
- **Payment Processing**: Stripe payment intents with commission calculation and manual payout management (Treasury model)
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
| Payments | Stripe |
| Email | SendGrid |
| Media | Cloudinary |
| Cache | Redis (ioredis) |
| Realtime | Socket.IO |
| Logging | Structured JSON logger (Logtail) |

## Prerequisites

- Node.js 20 or higher
- PostgreSQL 16 with PostGIS extension
- Firebase project with Admin SDK service account
- Stripe account
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

## Supplier & Payout Flow

### Stage 1: Supplier Onboarding

```
Customer wants to become a Supplier
        │
        ▼
┌─────────────────────────────────────────────────┐
│ 1. Apply (POST /api/suppliers/apply)            │
│    Fills in: business info, documents,           │
│    bank details, ID, etc. → Status: PENDING      │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│ 2. Admin Reviews Application                    │
│    (PATCH .../applications/:id/review)           │
│                                                 │
│    ┌──────────┐  ┌───────────┐  ┌──────────┐   │
│    │ APPROVE  │  │  REJECT   │  │ REQUEST  │   │
│    │ → APPROVED │  │ → REJECTED│  │  INFO    │   │
│    └────┬─────┘  └───────────┘  │→ UNDER_REVIEW│
│         │                       └──────────────┘
└─────────┴────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────┐
│ 3. Supplier Sets Up Payout Method                │
│    (POST /api/payout-methods)                    │
│                                                 │
│    Choose one:                                   │
│    ┌──────────┐ ┌────────────┐ ┌──────────┐    │
│    │   Bank   │ │  Mobile    │ │  PayPal  │    │
│    │ Transfer │ │   Money    │ │          │    │
│    └──────────┘ └────────────┘ └──────────┘    │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│ 4. Admin Verifies Payout Method                  │
│    (PATCH /api/payout-methods/admin/:id/verify)  │
│    → verified: true                              │
│                                                 │
│     Without this, supplier CANNOT publish     │
│       tours or receive payouts                   │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│ 5. Admin Activates Supplier                      │
│    (PATCH /api/suppliers/admin/:id/activate)     │
│    → Status: ACTIVE                            │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
              SUPPLIER IS NOW ACTIVE 
```

### Stage 2: Tour Creation & Sales

```
ACTIVE Supplier
       │
       ▼
┌──────────────────────────────────────────────┐
│ 6. Create & Publish Tours                    │
│    (POST /api/tours)                         │
│                                              │
│     Can't publish without verified         │
│       payout method (bank/momo/paypal)       │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────┐
│ 7. Customers Browse & Book                   │
│                                              │
│    Cart → Checkout → Pay via Stripe          │
│    (platform collects 100%)                  │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────┐
│ 8. Commission is Calculated                  │
│                                              │
│    Tier     │ Bookings │ Rate                │
│    ─────────┼──────────┼──────               │
│    Bronze   │ < 50     │ 15%                 │
│    Silver   │ 50-100   │ 13-14%              │
│    Gold     │ > 100    │ 12%                 │
│                                              │
│    Example: $100 booking, Bronze tier        │
│    → Commission: $15 (yours)                 │
│    → Supplier Payout: $85                    │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────┐
│ 9. Stripe Confirms Payment                   │
│    (Webhook: payment_intent.succeeded)        │
│                                              │
│     Booking → CONFIRMED                    │
│     Payout record created → PENDING        │
│     Supplier earnings updated              │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
         PAYOUT IS NOW PENDING 
```

### Stage 3: Admin Payout Process

```
Payout is PENDING
       │
       ▼
┌─────────────────────────────────────────────────┐
│ 10. Admin Reviews Pending Payouts                │
│     (GET /api/payouts/admin?status=PENDING)      │
│                                                  │
│     ┌─────────┬────────┬─────────┬────────┐     │
│     │Supplier │ Amount │ Booking │  Date  │     │
│     ├─────────┼────────┼─────────┼────────┤     │
│     │ John    │ $85    │  #1234  │ May 20 │     │
│     │ Sarah   │ $170   │  #1235  │ May 19 │     │
│     └─────────┴────────┴─────────┴────────┘     │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│ 11. Admin Approves Payout                       │
│     (PATCH /api/payouts/admin/:id/approve)      │
│     → APPROVED, Supplier notified               │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────── ─┐
│ 12. Admin Releases Payment                       │
│     (PATCH /api/payouts/admin/:id/release)       │
│                                                  │
│     Admin sends money via bank/MoMo/PayPal,      │
│     records: { reference, payoutMethod }         │
│     → PAID, Supplier notified                    │
└──────────────────────────────────────────────────┘
```

### Complete Flowchart

```
CUSTOMER           PLATFORM                 SUPPLIER
────────           ────────                 ────────
            ┌──────────────────┐
            │ 1. Apply        │◄──────── Customer
            │ → PENDING       │
            └────────┬─────────┘
                     │
            ┌────────▼─────────┐
            │ 2. Admin Review  │
            │ → APPROVED       │
            └────────┬─────────┘
                     │
            ┌────────▼─────────┐
            │ 3. Add Payout    │◄──────── Supplier
            │    Method        │
            └────────┬─────────┘
                     │
            ┌────────▼─────────┐
            │ 4. Admin Verifies│
            └────────┬─────────┘
                     │
            ┌────────▼─────────┐
            │ 5. Activate      │
            │ → ACTIVE         │
            └────────┬─────────┘
                     │
            ┌────────▼─────────┐
            │ 6. Create Tour   │◄──────── Supplier
            └────────┬─────────┘
                     │
┌────────┐  ┌────────▼─────────┐
│ 7. Book│─►│ Payment via Stripe│
│ Tour   │  │ Commission: 15%  │
└────────┘  │ Payout: $85      │
            └────────┬─────────┘
                     │
            ┌────────▼─────────┐
            │ 8. Webhook       │
            │ → CONFIRMED      │
            │ → Payout PENDING │
            └────────┬─────────┘
                     │
            ┌────────▼─────────┐
            │ 9. Admin Reviews │
            └────────┬─────────┘
                     │
            ┌────────▼─────────┐
            │ 10. Admin        │
            │     Approves     │
            │ → APPROVED       │
            └────────┬─────────┘
                     │
            ┌────────▼─────────┐
            │ 11. Admin Sends  │─────► Money to
            │     Money        │      Supplier
            │     → PAID       │
            └──────────────────┘
```

### Key Rules

| Rule | Why |
|------|-----|
| Supplier must be ACTIVE to create tours | Prevents incomplete applications from selling |
| Verified payout method required to publish | Ensures suppliers can actually receive money |
| Platform collects 100% via Stripe | Full control over refunds, disputes, customer experience |
| Commission locked at booking time | Tier changes don't affect past bookings |
| Payout created automatically on payment | No manual work — PENDING is ready for review |
| Admin manually approves + releases | Finance double-checks before sending money |
| Reference number recorded on release | Full audit trail for accounting |

### What Happens When Things Go Wrong?

| Problem | Outcome |
|---------|---------|
| Customer cancels | Booking → CANCELLED, payout handled manually |
| Payout fails (wrong bank details) | Admin → FAILED, supplier fixes method, re-release |
| Supplier is suspended | Existing payouts can still be processed |
| No verified payout method at release | Admin is blocked — supplier must add one |

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

**Last Updated**: May 21, 2026
**Version**: 2.1.0
