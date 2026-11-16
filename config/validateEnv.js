/**
 * Centralized environment variable validation.
 * Called once at each application's startup, before any service initializes.
 * In production, missing required vars cause an immediate exit.
 * In development, missing vars log warnings.
 *
 * Two applications, two requirement sets. A single shared list would either
 * force the Stays API to carry Stripe webhook plumbing it never uses, or let
 * the Platform API start without the SendGrid/Resend key that email depends
 * on. Each list below is what that process actually reads.
 */

const isProduction = () => process.env.NODE_ENV === 'production';

/**
 * Platform API requirements.
 *
 * `SENDGRID_API_KEY` used to be listed here. Nothing in the codebase reads it
 * (the transactional email provider is Resend — see `emailService.js` and
 * `chatEmailIngest.js`), while `.env.example` documents `RESEND_API_KEY`.
 * Requiring the unused key meant a clean host bootstrapped from the example
 * exited on startup, and it hid the real requirement.
 */
const PLATFORM_REQUIRED_IN_PROD = [
  'DATABASE_URL',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'RESEND_API_KEY',
];

/**
 * Stays API requirements.
 *
 * Only what the accommodation application reads:
 *  - DATABASE_URL: shared Prisma schema, every request.
 *  - JWT_SECRET / JWT_REFRESH_SECRET: `config/jwt.js` throws in production
 *    without them, and `protect` verifies access tokens with JWT_SECRET.
 *  - CLOUDINARY_*: property photo and verification-document uploads.
 *
 * Deliberately absent: STRIPE_WEBHOOK_SECRET (Stays receives no Stripe
 * webhooks), RESEND_API_KEY (Stays sends no email of its own), Firebase/Google
 * OAuth (Stays mounts no auth routes). Least privilege per container.
 */
const STAYS_REQUIRED_IN_PROD = [
  'DATABASE_URL',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
];

const PLATFORM_RECOMMENDED = [
  'REDIS_URL',
  'CLIENT_URL',
  'SUPPLIER_DASHBOARD_URL',
  'ALLOWED_ORIGINS',
  'SENTRY_DSN',
  'GEOAPIFY_API_KEY',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_PRIVATE_KEY',
];

const STAYS_RECOMMENDED = [
  'REDIS_URL',
  'ALLOWED_ORIGINS',
  'CLIENT_URL',
  'SUPPLIER_DASHBOARD_URL',
  'SENTRY_DSN',
];

function reportMissing(required, recommended, label) {
  const warnings = [];

  for (const key of required) {
    if (!process.env[key]) {
      if (isProduction()) {
        // Fatal in production: starting without a required key (e.g. a Stripe
        // secret) would silently ship broken payments / email. Fail fast.
        console.error(`[ENV] FATAL (${label}): Missing required env var in production: ${key}`);
        process.exit(1);
      } else {
        warnings.push(key);
      }
    }
  }

  for (const key of recommended) {
    if (!process.env[key]) {
      warnings.push(key);
    }
  }

  if (warnings.length > 0) {
    console.warn(`[ENV] Warning (${label}): Missing optional/recommended environment variables:`);
    warnings.forEach((k) => console.warn(`  - ${k}`));
  }

  console.log(`[ENV] ${label}: environment validation passed`);
}

function validateEnv() {
  reportMissing(PLATFORM_REQUIRED_IN_PROD, PLATFORM_RECOMMENDED, 'platform-api');
}

function validateStaysEnv() {
  reportMissing(STAYS_REQUIRED_IN_PROD, STAYS_RECOMMENDED, 'stays-api');
}

module.exports = {
  validateEnv,
  validateStaysEnv,
  PLATFORM_REQUIRED_IN_PROD,
  STAYS_REQUIRED_IN_PROD,
};
