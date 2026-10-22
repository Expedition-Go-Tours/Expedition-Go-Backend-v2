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

describe('CORS — response headers the browser may read', () => {
  // An origin on the allow-list (config/corsOrigins.js DEV_ORIGINS): the
  // middleware emits no CORS headers at all for a refused origin, so a
  // disallowed one would make this test assert nothing.
  const ORIGIN = 'http://localhost:5173';

  it('exposes Content-Disposition so the export filename reaches the client', async () => {
    const res = await request(app)
      .get('/api/travioghana/supplier/bookings/export')
      .set('Origin', ORIGIN);

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
});
