# Expedition Go Backend v2

Production-ready tour booking platform backend built with Node.js, Express, Prisma ORM, PostgreSQL (PostGIS), Firebase Authentication, and Stripe.

## Features

- **Multi-role Authentication**: Customer, Supplier, and Admin roles with Firebase token verification
- **Tour Management**: Full CRUD with rich metadata, PostGIS geo-search, categorization, date overrides, and pagination
- **Booking System**: Full lifecycle with conflict detection, Stripe Payment Intent integration, commission splits, and cart management
- **Review System**: Customer reviews with moderation, supplier responses, rating aggregation, and verified booking badges
- **Supplier Onboarding**: Application workflow with document upload, admin review, compliance checks, and payout method setup
- **Chat System**: Real-time messaging between suppliers, customers, and admins via Socket.IO
- **Notifications**: Real-time (Socket.IO), email (SendGrid), and in-app notification service for both users and admins
- **Payment Processing**: Stripe payment intents with commission calculation and manual payout management (Treasury model)
- **Team Management**: Suppliers can invite team members with role-based access (editor, viewer, etc.)
- **RBAC**: Granular admin permissions system with custom roles (super_admin, finance_admin, etc.)
- **Analytics & Events**: Event tracking for user journeys, funnels, and business analytics
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

## Database Schema

The database uses PostgreSQL 16 with PostGIS for geo-location queries. The schema is managed via Prisma migrations in `prisma/migrations/`.

### Enums

| Enum | Values |
|------|--------|
| `UserRole` | `customer`, `supplier`, `admin` |
| `SupplierStatus` | `PENDING`, `UNDER_REVIEW`, `APPROVED`, `ACTIVE`, `SUSPENDED`, `REJECTED` |
| `TourStatus` | `DRAFT`, `ACTIVE`, `PAUSED`, `ARCHIVED` |
| `BookingStatus` | `PENDING`, `CONFIRMED`, `CANCELLED`, `REFUNDED`, `COMPLETED`, `NO_SHOW` |
| `PaymentStatus` | `PENDING`, `PROCESSING`, `SUCCEEDED`, `FAILED`, `CANCELLED`, `REFUNDED` |
| `PayoutStatus` | `PENDING`, `APPROVED`, `PROCESSING`, `PAID`, `FAILED`, `CANCELLED` |
| `PayoutMethodType` | `BANK_TRANSFER`, `PAYPAL` |
| `ReviewStatus` | `PENDING`, `APPROVED`, `REJECTED`, `FLAGGED` |
| `OverrideStatus` | `AVAILABLE`, `LIMITED`, `FULL`, `BLOCKED` |
| `NotificationType` | `BOOKING_CONFIRMED`, `BOOKING_CANCELLED`, `PAYMENT_RECEIVED`, `REVIEW_RECEIVED`, `SUPPLIER_APPROVED`, `SUPPLIER_REJECTED`, `PAYOUT_PROCESSED`, `PAYOUT_APPROVED`, `SYSTEM_ALERT`, `NEW_MESSAGE` |
| `AdminNotificationType` | `NEW_SUPPLIER_APPLICATION`, `SUPPLIER_STATUS_CHANGE`, `REVIEW_NEEDS_MODERATION`, `PAYOUT_NEEDS_APPROVAL`, `SYSTEM_ALERT`, `NEW_MESSAGE` |
| `ConversationType` | `SUPPLIER_ADMIN`, `SUPPLIER_CUSTOMER`, `USER_SUPPORT` |

### Models

#### User & Profile
- **User** — Core user record linked to Firebase Auth (`firebaseUid`). Supports multiple roles (customer, supplier, admin) via the `roles` array field. Includes Stripe customer ID, language/timezone preferences, notification settings (JSON), wishlist, and likes. Admin users have a role-level `adminRoleId` linking to `AdminRole`.
- **SupplierProfile** — Extended profile for supplier users. Contains business info, operating info, representative details, business documents, payout preferences, and compliance data — all stored as JSON blobs. Tracks earnings, bookings, and average rating. Managed through the admin review workflow (status transitions: PENDING → UNDER_REVIEW → APPROVED → ACTIVE).

#### Tours
- **Tour** — Central product entity. Each tour belongs to a supplier and includes:
  - Basic info (title, description, photos, cover photo, status)
  - **Categorization** (JSON): category, subcategory, activity type, difficulty, duration
  - **Theme** (JSON): primary theme + secondary themes in a separate `TourSecondaryTheme` table
  - **Product content** (JSON): included items, what to bring, highlights, restrictions
  - **Schedules & pricing** (JSON): multi-variant pricing by group size, seasonal rates
  - **Booking & tickets** (JSON): meeting point, check-in process, cancellation policy
  - **SEO**: slug (unique), meta title/description, tags
  - **Location**: lat/lng + PostGIS `geography(Point, 4326)` column (`location_geom`) for geo-search via `ST_DWithin`. City, country, and region are denormalized for indexed filtering.
  - Normalized fields for filtering: `category`, `subcategory`, `activityType`, `difficulty`, `durationMinutes`, `primaryTheme`
  - Statistics: total bookings, revenue, average rating, review count, view count
- **TourDateOverride** — Per-date availability override. Allows suppliers to set custom capacity, time-slot overrides, or block specific dates.
- **TourSecondaryTheme** — Many-to-many secondary themes for a tour (e.g., "Nature & Wildlife" + "Photography").

#### Bookings
- **Booking** — Records a customer's booking on a tour. Includes:
  - Traveler details (JSON), selected date/time
  - Full pricing breakdown: subtotal, taxes, fees, discounts, total, currency
  - Commission: locked rate at time of booking, commission amount, supplier payout
  - Stripe payment intent ID, payment status, paid timestamp
  - Cancellation tracking: reason, timestamp, refund amount
  - Special requests and supplier notes
  - Generated booking number (`bookingNumber`) — human-readable reference
- **CartItem** — Shopping cart for unauthenticated/authenticated users. Each item links a customer to a tour with selected date, time, and traveler details. Pricing is snapshotted at add time. Items expire after a configurable period (`expiresAt`).

#### Payments & Payouts
- **PayoutMethod** — Supplier payout destinations. Supports bank transfer (bank name, account number, routing, SWIFT, IBAN, sort code, branch code) and PayPal (email). Mobile money fields (provider, number) are defined but the enum excludes `MOBILE_MONEY` for now. Methods must be admin-verified before the supplier can publish tours or receive payouts.
- **Payout** — Links a booking to a supplier's payout. Tracks full lifecycle: PENDING → APPROVED → PROCESSING → PAID. Records admin approval/processing, payout method used, payment provider reference, and admin notes. Commission amount is stored for accounting.
- **StripeEvent** — Idempotency tracking for Stripe webhook events. Stores the raw event data and processing status to prevent double-processing.

#### Reviews
- **Review** — Customer reviews tied to a completed booking (1:1 relationship). Includes rating (1-5), title, comment, and optional photos. Moderation workflow: PENDING → APPROVED/REJECTED/FLAGGED. Supports supplier responses and tracks helpfulness votes and abuse reports.

#### Chat
- **Conversation** — Chat thread between participants. Types: SUPPLIER_ADMIN, SUPPLIER_CUSTOMER, USER_SUPPORT.
- **ConversationParticipant** — Join table linking users to conversations with `lastReadAt` for unread tracking.
- **Message** — Individual chat messages with text content, optional attachment (Cloudinary URL + type), and edit tracking.

#### Notifications
- **Notification** — User-facing in-app notifications with type, title, message, and structured data (JSON). Tracks read status and email/push delivery status.
- **AdminNotification** — Admin-specific notifications (new supplier applications, reviews needing moderation, payouts needing approval). Tracked separately with acknowledge workflow.

#### Team Management
- **TeamMember** — Allows suppliers to invite team members (editors, viewers) to help manage their tours and bookings. Invitations use a token-based flow with expiry. Status: PENDING → ACCEPTED.

#### Admin & RBAC
- **AdminRole** — Named roles (e.g., `super_admin`, `finance_admin`, `support_admin`). The `super_admin` role is system-protected (cannot be deleted/modified).
- **AdminPermission** — Granular permissions defined by unique key (e.g., `suppliers.approve`, `payouts.view`), grouped by category.
- **AdminRolePermission** — Many-to-many join linking roles to permissions.

#### System
- **SystemConfig** — Key-value configuration store for platform-wide settings (platform name, currency, commission rates, email branding, maintenance mode, etc.). Values are JSON, set by admins via the admin dashboard.
- **AuditLog** — Immutable audit trail for admin actions. Records actor (user ID/email), IP, user agent, action name, affected resource, old/new values (JSON), and arbitrary metadata.
- **Event** — Analytics event tracking. Captures dot-notation event names (`booking.completed`, `tour.viewed`), user/session attribution, resource references, event properties (JSON), and source (web/mobile/api/webhook). Indexed for time-series and funnel analysis.

### Key Indexes

| Model | Indexes |
|-------|---------|
| User | `email`, `roles`, `createdAt`, `stripeCustomerId` |
| Tour | `supplierId`, `status`, `slug`, `createdAt`, `averageRating`, `category`, `subcategory`, `activityType`, `difficulty`, `primaryTheme`, `durationMinutes`, `city`, `country`, `region`, `country+city`, PostGIS geo-index on `location_geom` |
| Booking | `customerId`, `tourId`, `status`, `selectedDate`, `bookingNumber`, `stripePaymentIntentId` |
| Payout | `supplierId`, `status`, `createdAt`, `supplierId+status`, `supplierId+createdAt`, `bookingId`, `payoutMethodId` |
| Review | `tourId`, `customerId`, `rating`, `status`, `createdAt` |
| Event | `name`, `userId`, `resource+resourceId`, `createdAt`, `name+createdAt`, `userId+name+createdAt` |
| AuditLog | `userId`, `action`, `resource`, `createdAt` |

### PostGIS Geo-Search

Tours include a `location_geom` column (`geography(Point, 4326)`) populated by a database trigger on insert/update of `latitude`/`longitude`. The `findToursNearby` query uses `ST_DWithin` for radius-based search:

```sql
SELECT * FROM "Tour"
WHERE ST_DWithin(location_geom, ST_SetSRID(ST_MakePoint($lng, $lat), 4326)::geography, $radiusMeters)
  AND status = 'ACTIVE';
```

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
   EMAIL_REPLY_TO=support@travioafrica.com

   # Supabase (for Storage / realtime subscriptions)
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
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
├── middleware/          # Auth, error handling, file upload, rate limiting
├── prisma/              # Schema, migrations, PostGIS extensions
├── routes/              # Express route definitions
├── utils/               # Helpers: Stripe, email, SendGrid templates, cache, logger, queue, notifications, chat
├── email-templates/     # MJML source + compiled HTML for SendGrid templates
├── sendgrid-templates/  # Static HTML templates uploaded to SendGrid
├── __tests__/           # Test suites (unit, integration, API)
├── .github/workflows/   # CI/CD pipeline
├── app.js               # Express application setup
├── server.js            # Entry point with graceful shutdown
└── package.json
```

## Key Endpoints

### Authentication & Users
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/users/signup` | Create or get user profile (idempotent) |
| PATCH | `/api/users/sync-me` | Sync user profile with Firebase |
| GET | `/api/users/me` | Get current user profile |
| GET | `/api/users/:id` | Get user profile by ID |
| PATCH | `/api/users/me` | Update own profile |
| GET | `/api/users` | List users (admin only, paginated) |

### Tours
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tours` | List tours (pagination, filters, geo-search, sorting) |
| GET | `/api/tours/:slug` | Get tour details by slug |
| GET | `/api/tours/:slug/related` | Get related tours |
| POST | `/api/tours` | Create tour (supplier only) |
| PATCH | `/api/tours/:id` | Update tour (supplier only) |
| DELETE | `/api/tours/:id` | Delete tour (supplier only, soft) |
| PATCH | `/api/tours/:id/status` | Change tour status (supplier only) |
| GET | `/api/tours/supplier/mine` | List supplier's own tours |
| PATCH | `/api/tours/:id/date-overrides` | Manage date overrides |

### Bookings
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/bookings` | Create booking with Stripe payment |
| POST | `/api/bookings/admin` | Admin creates booking manually |
| GET | `/api/bookings/my-bookings` | List current user's bookings |
| GET | `/api/bookings/:id` | Get booking details (with ticket) |
| PATCH | `/api/bookings/:id/cancel` | Cancel booking |
| GET | `/api/bookings/all` | List all bookings (admin only) |
| GET | `/api/bookings/tour/:tourId` | List bookings for a tour (supplier only) |

### Cart
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/cart` | Add item to cart |
| GET | `/api/cart` | Get current cart |
| DELETE | `/api/cart/:itemId` | Remove cart item |
| DELETE | `/api/cart` | Clear entire cart |

### Reviews
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/reviews` | Submit review (requires completed booking) |
| GET | `/api/reviews/tour/:tourId` | Get tour reviews |
| PATCH | `/api/reviews/:id/respond` | Supplier response |
| PATCH | `/api/reviews/:id/moderate` | Admin moderation (approve/reject/flag) |
| GET | `/api/reviews/pending` | List pending reviews (admin only) |

### Suppliers
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/suppliers/apply` | Submit supplier application |
| GET | `/api/suppliers/dashboard` | Supplier dashboard stats |
| GET | `/api/suppliers/profile` | Get supplier profile |
| PATCH | `/api/suppliers/profile` | Update supplier profile |
| GET | `/api/suppliers/admin/applications` | Admin: view applications |
| PATCH | `/api/suppliers/admin/:id/review` | Admin: review application |
| PATCH | `/api/suppliers/admin/:id/activate` | Admin: activate supplier |

### Payouts
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/payout-methods` | Add payout method (supplier) |
| GET | `/api/payout-methods` | List supplier's payout methods |
| DELETE | `/api/payout-methods/:id` | Remove payout method |
| PATCH | `/api/payout-methods/admin/:id/verify` | Admin: verify payout method |
| GET | `/api/payouts` | List supplier's payouts |
| GET | `/api/payouts/admin` | Admin: list all payouts (filterable by status) |
| PATCH | `/api/payouts/admin/:id/approve` | Admin: approve payout |
| PATCH | `/api/payouts/admin/:id/release` | Admin: mark payout as paid |

### Notifications
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/notifications` | List user's notifications |
| PATCH | `/api/notifications/:id/read` | Mark notification as read |
| GET | `/api/admin/notifications` | List admin notifications |
| PATCH | `/api/admin/notifications/:id/acknowledge` | Acknowledge admin notification |

### Chat
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/chat/conversations` | List user's conversations |
| POST | `/api/chat/conversations` | Create conversation |
| GET | `/api/chat/conversations/:id` | Get conversation with messages |
| POST | `/api/chat/conversations/:id/messages` | Send message |
| PATCH | `/api/chat/conversations/:id/read` | Mark conversation as read |

### Team Management
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/team` | List team members (supplier) |
| POST | `/api/team/invite` | Invite team member |
| POST | `/api/team/accept` | Accept invitation (via token) |
| DELETE | `/api/team/:id` | Remove team member |

### Admin Settings
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/settings` | Get all system config |
| GET | `/api/admin/settings/:key` | Get specific config value |
| PUT | `/api/admin/settings` | Batch update settings |
| GET | `/api/admin/roles` | List admin roles |
| POST | `/api/admin/roles` | Create admin role |
| PATCH | `/api/admin/roles/:id` | Update admin role |
| DELETE | `/api/admin/roles/:id` | Delete admin role |
| GET | `/api/admin/permissions` | List all permissions |
| GET | `/api/admin/users` | List admin users |
| PATCH | `/api/admin/users/:id/role` | Change admin's role |
| GET | `/api/admin/audit-log` | Query audit log (paginated, filterable) |

### Analytics
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/analytics/summary` | Dashboard summary stats |
| GET | `/api/analytics/revenue` | Revenue data (time-series) |
| GET | `/api/analytics/bookings` | Booking metrics |
| GET | `/api/analytics/users` | User growth data |
| POST | `/api/analytics/events` | Track custom event |

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

The project includes **853 tests across 42 suites** with Jest + Supertest, validated in CI against a fresh PostgreSQL container.

```bash
# Run all tests
npm test

# Run with coverage report
npx jest --coverage
```

### Test Suites

| Suite | Type | Scope |
|-------|------|-------|
| `__tests__/unit/*` | Unit | Email service, AppError, cache, chat, notification helpers |
| `__tests__/api/*` | API | Health, tours, bookings, reviews, carts, suppliers, payouts, auth |
| `__tests__/user.integration.*` | Integration | Prisma + PostgreSQL CRUD |

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

**Last Updated**: June 12, 2026
**Version**: 2.2.0
