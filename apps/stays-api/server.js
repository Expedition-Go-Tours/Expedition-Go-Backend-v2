/**
 * Stays API — process entry point.
 *
 * Intentionally small. Compare with `apps/platform-api/server.js`, which also
 * boots Socket.IO, BullMQ workers, scheduled jobs, the AI cron fallback, the
 * chat email poller and the BM25 index. None of that belongs to Stays.
 *
 * What this process does:
 *   1. load `.env` (resolved from the repo root, not the cwd)
 *   2. validate the environment variables Stays actually needs
 *   3. serve the Stays router + `/health` + `/ready` on 127.0.0.1:5100
 *   4. shut down gracefully on SIGTERM (Docker stop) and SIGINT
 *
 * What it never does:
 *   - register a queue worker or a scheduled job (no duplicate schedulers)
 *   - start Socket.IO
 *   - run a database migration or `prisma db push`
 *   - require the Platform API process to be running
 */

const dotenv = require('dotenv');
const http = require('http');
const path = require('path');

const ENV_FILE = path.resolve(__dirname, '../../.env');
dotenv.config({ path: ENV_FILE });

// Reuse the GA4 reconciliation? Not needed here — Stays sends no GA4 events and
// has no publish pipeline. Skipping it keeps this process free of that concern.

const { validateStaysEnv } = require('../../config/validateEnv');
validateStaysEnv();

const app = require('./app');
const prisma = require('../../src/core/services/prismaClient');
const redisClient = require('../../src/core/services/redisClient');
const logger = require('../../src/core/services/logger');

const port = Number(process.env.STAYS_PORT || process.env.PORT || 5100);
const host = process.env.STAYS_HOST || process.env.HOST || '127.0.0.1';

const server = http.createServer(app);

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[Startup] stays-api: port ${host}:${port} already in use — is another Stays container running?`);
  } else {
    console.error('[Startup] stays-api HTTP server error:', err?.message || err);
  }
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`[Startup] stays-api listening on ${host}:${port}`);
  console.log(`[Startup] Environment: ${process.env.NODE_ENV}`);
  console.log(`[Startup] Release: ${process.env.RELEASE_VERSION || 'dev'} (${process.env.RELEASE_COMMIT || 'no-commit'})`);
});

let shuttingDown = false;

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Shutdown] stays-api: ${reason}`);

  // Stop accepting new connections, then let in-flight requests finish.
  server.close(async (err) => {
    if (err) console.error('[Shutdown] server.close error:', err.message);
    try {
      await prisma.$disconnect();
    } catch (e) {
      console.error('[Shutdown] prisma disconnect error:', e?.message || e);
    }
    try {
      await redisClient.quit();
    } catch (e) {
      console.error('[Shutdown] redis quit error:', e?.message || e);
    }
    logger?.flush?.();
    process.exit(0);
  });

  // Do not hang forever on a stuck connection (Docker's stop timeout is 10s by
  // default; exit before it so the container is not SIGKILLed).
  setTimeout(() => {
    console.error('[Shutdown] forced exit after timeout');
    process.exit(1);
  }, 8000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM received'));
process.on('SIGINT', () => shutdown('SIGINT received'));

process.on('unhandledRejection', (err) => {
  console.error('[stays-api] Unhandled rejection:', err?.stack || err?.message || err);
  shutdown('UNHANDLED REJECTION');
});

process.on('uncaughtException', (err) => {
  console.error('[stays-api] Uncaught exception:', err?.stack || err?.message || err);
  shutdown('UNCAUGHT EXCEPTION');
});

module.exports = server;
