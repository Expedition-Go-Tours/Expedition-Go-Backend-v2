/**
 * Stays bootstrap isolation.
 *
 * The architectural claim under test is narrow and concrete: starting the Stays
 * API must not start anything that belongs to the Platform API. If a future
 * refactor copies `server.js` into the Stays app "just to get it running", this
 * suite fails before that reaches production and duplicates a scheduler or a
 * BullMQ consumer.
 */
const fs = require('fs');
const path = require('path');
const request = require('supertest');

// Fail the suite if anything constructs a BullMQ Worker while the Stays app is
// being loaded. `Queue` is a lazy handle and may exist; `Worker` consumes jobs.
jest.mock('bullmq', () => ({
  Queue: jest.fn(),
  Worker: jest.fn(),
}));

const { Worker } = require('bullmq');
const queue = require('../../src/core/services/queue');

const STAYS_APP = require('../../apps/stays-api/app');
const { buildStaysApp } = require('../../apps/stays-api/app');

const repoRoot = path.resolve(__dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

describe('Stays application bootstrap', () => {
  it('registers no workers and no schedules', () => {
    expect(queue.registerWorkers).toBeDefined();
    expect(queue.registerSchedules).toBeDefined();
    expect(Worker).not.toHaveBeenCalled();
  });

  it('does not load the Platform API module', () => {
    const platformPath = require.resolve('../../apps/platform-api/app');
    expect(require.cache[platformPath]).toBeUndefined();
  });

  it('does not load Socket.IO', () => {
    const socketPath = require.resolve('socket.io');
    expect(require.cache[socketPath]).toBeUndefined();
  });

  it('does not reference worker, scheduler or realtime entry points', () => {
    for (const file of ['apps/stays-api/app.js', 'apps/stays-api/server.js']) {
      const source = read(file);
      expect(source).not.toMatch(/socket\.io/);
      expect(source).not.toMatch(/registerWorkers/);
      expect(source).not.toMatch(/registerSchedules/);
      expect(source).not.toMatch(/startAiCronFallback/);
      expect(source).not.toMatch(/pollReceivedEmails/);
      // No in-process schedules. A `setTimeout` for the shutdown watchdog is
      // allowed and is the only timer in server.js.
      expect(source).not.toMatch(/setInterval\(/);
      expect(source).not.toMatch(/node-cron|startAiCron|aiCronFallback/);
    }
  });

  it('mounts the stays router under exactly two prefixes', () => {
    const app = buildStaysApp();
    const routerLayers = app._router.stack.filter(
      (layer) => layer.name === 'router' && layer.regexp && /stays/.test(layer.regexp.source),
    );
    expect(routerLayers).toHaveLength(2);
    const sources = routerLayers.map((l) => l.regexp.source);
    expect(sources.some((s) => s.includes('v1'))).toBe(true);
    expect(sources.some((s) => !s.includes('v1'))).toBe(true);
  });

  it('serves the stays contract and nothing from the platform', async () => {
    const legacy = await request(STAYS_APP).get('/api/travioghana/supplier/stays/properties');
    const canonical = await request(STAYS_APP).get('/api/v1/travioghana/supplier/stays/properties');

    // 401, not 404: the route exists and is guarded by `protect`.
    expect(legacy.status).toBe(401);
    expect(canonical.status).toBe(401);
    expect(legacy.headers['x-served-by']).toBe('stays-api');
    expect(canonical.headers['x-served-by']).toBe('stays-api');

    // A Tours route is owned by the Platform API and must not appear here.
    const tours = await request(STAYS_APP).get('/api/tours');
    expect(tours.status).toBe(404);
    expect(tours.headers['x-served-by']).toBe('stays-api');

    // Neither should the Platform's own probes-less root advertise those routes.
    const versionedTours = await request(STAYS_APP).get('/api/v1/tours');
    expect(versionedTours.status).toBe(404);
  });

  it('identifies itself as stays-api in its probe payload', async () => {
    // The database is unreachable in the unit run, so /ready is a 503 — but the
    // service identity must still be Stays, never platform-api.
    const health = await request(STAYS_APP).get('/health');
    expect(health.body.service).toBe('stays-api');
    expect(health.body.version).toBeDefined();
  });
});
