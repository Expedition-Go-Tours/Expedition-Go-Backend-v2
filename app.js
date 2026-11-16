/**
 * Compatibility shim.
 *
 * The Platform API composition root now lives in `apps/platform-api/app.js`.
 * This file exists so that:
 *
 *   - every existing test that does `require('../app')` keeps working,
 *   - PM2's `script: 'server.js'` keeps pointing at a real entry point,
 *   - anything that has not been migrated yet can keep resolving `./app`.
 *
 * It exports the exact same Express instance as before the split — same
 * middleware order, same 965 route registrations, plus the canonical
 * `/api/v1` aliases. Do not add logic here; put it in the platform app.
 */
module.exports = require('./apps/platform-api/app');
