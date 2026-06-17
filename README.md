# TravioAfrica Backend API

Express + Prisma + PostgreSQL + Redis backend for TravioAfrica platform.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js |
| Framework | Express |
| Database | PostgreSQL 16 (with PostGIS) |
| ORM | Prisma 5 |
| Cache | Redis 7 |
| Auth | Firebase Admin SDK |
| Payments | Stripe |
| Media | Cloudinary |
| Email | SendGrid |
| Real-time | Socket.IO |
| Monitoring | Sentry + Logtail (Better Stack) |

## Quick Start

### Prerequisites

- Node.js 20+
- Docker Desktop

### Setup

```bash
# 1. Start PostgreSQL and Redis
docker compose up -d

# 2. Install dependencies
npm install

# 3. Apply database migrations
npx prisma migrate dev

# 4. Seed permissions, roles, and sample data
npx prisma db seed

# 5. Start in development mode (with auto-reload)
npm run dev
```

The API runs at `http://localhost:5000`.

### Environment Variables

Copy the default configuration from `.env` — the defaults point to local Docker services:

| Variable | Default (local) | Description |
|----------|----------------|-------------|
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5433/travio` | PostgreSQL connection |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection |
| `FIREBASE_PROJECT_ID` | — | Firebase project ID |
| `CLOUDINARY_CLOUD_NAME` | — | Cloudinary media storage |
| `STRIPE_SECRET_KEY` | — | Stripe payments |
| `SENDGRID_API_KEY` | — | Email service |
| `SENTRY_DSN` | — | Error monitoring |
| `LOGTAIL_TOKEN` | — | Structured logging |

> **Important:** `DATABASE_URL` uses port **5433** to avoid conflicts with native PostgreSQL installations on Windows. Redis uses the default **6379**.

### Useful Commands

```bash
# Start/stop services
docker compose up -d
docker compose down

# Wipe database and start fresh
docker compose down -v
docker compose up -d
npx prisma migrate dev
npx prisma db seed

# View Prisma Studio (database GUI)
npx prisma studio
```

## API Documentation

Swagger docs available at `http://localhost:5000/api-docs` when running locally.

## Project Structure

```
Backendv2/
├── prisma/              # Schema, migrations, seed
├── routes/              # Express route definitions
├── middleware/           # Auth, error handling, uploads
├── controllers/         # Request handlers
├── utils/               # Shared utilities (email, cache, queue, etc.)
├── config/              # Firebase, Cloudinary, Swagger configs
├── __tests__/           # Unit, integration, E2E, performance tests
├── scripts/             # One-off admin scripts
├── app.js               # Express app setup
├── server.js            # Entry point with Socket.IO + queue workers
└── docker-compose.yml   # Local PostgreSQL + Redis
```
