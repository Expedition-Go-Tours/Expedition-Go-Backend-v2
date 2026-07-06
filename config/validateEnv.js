/**
 * Centralized environment variable validation.
 * Called once at server startup before any services initialize.
 * In production, missing vars cause an immediate exit.
 * In development, missing vars log warnings.
 */

const REQUIRED_IN_PROD = [
  'DATABASE_URL',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'SENDGRID_API_KEY',
];

const RECOMMENDED = [
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

function validateEnv() {
  const isProduction = process.env.NODE_ENV === 'production';
  const missing = [];
  const warnings = [];

  for (const key of REQUIRED_IN_PROD) {
    if (!process.env[key]) {
      if (isProduction) {
        missing.push(key);
      } else {
        warnings.push(key);
      }
    }
  }

  for (const key of RECOMMENDED) {
    if (!process.env[key]) {
      warnings.push(key);
    }
  }

  if (missing.length > 0) {
    console.error(`[ENV] CRITICAL: Missing required environment variables in production:`);
    missing.forEach(k => console.error(`  - ${k}`));
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.warn(`[ENV] Warning: Missing optional/recommended environment variables:`);
    warnings.forEach(k => console.warn(`  - ${k}`));
  }

  console.log('[ENV] Environment validation passed');
}

module.exports = { validateEnv };
