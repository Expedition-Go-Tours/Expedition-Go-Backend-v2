/**
 * Compatibility shim.
 *
 * The Platform API process entry point now lives in
 * `apps/platform-api/server.js`. This file exists so that the current PM2
 * process definition (`ecosystem.config.js` → `script: 'server.js'`) and the
 * existing deploy script keep working without any change on the running server.
 *
 * Starting the Platform API is unchanged:
 *
 *   node server.js          # what PM2 runs today
 *   node apps/platform-api/server.js   # the real entry point, same thing
 *
 * The Stays API has its own entry point — `node apps/stays-api/server.js` —
 * and never loads this file.
 */
require('./apps/platform-api/server');
