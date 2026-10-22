/**
 * The CSV export names its file with `Content-Disposition`, and the browser
 * only hands that header to JavaScript when the server exposes it through
 * CORS. Without `Access-Control-Expose-Headers`, the supplier's download
 * silently ignores the server's filename and takes the client's fallback
 * instead — exactly what happened before this existed (and the E2E for it was
 * green only because both names happened to contain today's date).
 *
 * This asserts the header travels on the real Express app, since that is the
 * only place the two halves (server names the file / client reads the name)
 * meet.
 */
const request = require('supertest');
const app = require('../../app');

// The origin allow-list is environment-dependent (config/corsOrigins.js):
// ALLOWED_ORIGINS REPLACES the localhost dev defaults, and the CI jobs set it
// to `http://localhost:3000`. A test that picks its origin from the ambient
// environment therefore passes locally and fails in CI — or worse, passes in
// both while asserting nothing, because a REFUSED origin gets no CORS headers
// at all. Pin the allow-list here so the assertion is the same everywhere.
const ORIGIN = 'http://localhost:3000';
let savedAllowedOrigins;

beforeAll(() => {
  savedAllowedOrigins = process.env.ALLOWED_ORIGINS;
  process.env.ALLOWED_ORIGINS = ORIGIN;
});

afterAll(() => {
  if (savedAllowedOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
  else process.env.ALLOWED_ORIGINS = savedAllowedOrigins;
});

describe('CORS — response headers the browser may read', () => {
  it('exposes Content-Disposition so the export filename reaches the client', async () => {
    const res = await request(app)
      .get('/api/travioghana/supplier/bookings/export')
      .set('Origin', ORIGIN);

    // The origin must actually be allowed, otherwise the assertion below is
    // vacuous: a refused request carries no CORS headers to inspect.
    expect(res.headers['access-control-allow-origin']).toBeTruthy();

    const exposed = String(res.headers['access-control-expose-headers'] || '');
    expect(exposed.toLowerCase()).toContain('content-disposition');
  });

  it('still exposes it on an error response, when the export cannot run', async () => {
    // No token: the guard refuses before any query runs. The CORS layer sits
    // in front of it, so the exposure must survive the error path too — a
    // filename that is only readable on success is not much of a guarantee.
    const res = await request(app)
      .get('/api/travioghana/supplier/bookings/export')
      .set('Origin', ORIGIN);

    expect(res.status).toBeGreaterThanOrEqual(400);
    const exposed = String(res.headers['access-control-expose-headers'] || '');
    expect(exposed.toLowerCase()).toContain('content-disposition');
  });

  it('does not expose internal headers to a disallowed origin', async () => {
    // The counterpart: exposure must not become a blanket leak. A refused
    // origin gets no CORS surface at all.
    const res = await request(app)
      .get('/api/travioghana/supplier/bookings/export')
      .set('Origin', 'https://evil.example.com');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-expose-headers']).toBeUndefined();
  });
});
