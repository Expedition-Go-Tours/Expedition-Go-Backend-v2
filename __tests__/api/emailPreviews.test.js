/**
 * Admin transactional-email preview gallery — HTTP surface.
 *
 * Read routes are gated by a short-lived signed token (they open in a plain
 * browser), so they must be reachable WITHOUT an Authorization header; the mint
 * route must still require admin auth. These tests pin that split plus the CSP
 * overrides the gallery and its framed previews need.
 */
const request = require('supertest');

process.env.EMAIL_PREVIEW_TOKEN_SECRET = process.env.EMAIL_PREVIEW_TOKEN_SECRET || 'api-test-secret';

const app = require('../../app');
const previews = require('../../src/core/services/emailPreviews');

const BASE = '/api/admin/email-previews';

describe('admin email preview gallery', () => {
  it('rejects a read with no token (403 styled page, not JSON)', async () => {
    const res = await request(app).get(BASE);
    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('Preview link expired');
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('rejects a read with a bad token', async () => {
    const res = await request(app).get(`${BASE}?token=not.a.real.token`);
    expect(res.status).toBe(403);
  });

  it('renders the gallery for a valid token, framable only same-origin', async () => {
    const token = previews.signPreviewToken(60_000);
    const res = await request(app).get(`${BASE}?token=${encodeURIComponent(token)}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('<!doctype html');
    // Each card frames the sibling token-gated template route.
    expect(res.text).toContain(`${BASE}/template/booking-confirmed?token=`);
    expect(res.headers['content-security-policy']).toContain("frame-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('serves a single rendered template frameable by the gallery', async () => {
    const token = previews.signPreviewToken(60_000);
    const res = await request(app).get(
      `${BASE}/template/booking-confirmed?token=${encodeURIComponent(token)}`,
    );

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/<!doctype html>/i);
    expect(res.text).not.toContain('{{');
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain('img-src https: data:');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('404s an unknown template key', async () => {
    const token = previews.signPreviewToken(60_000);
    const res = await request(app).get(`${BASE}/template/nope?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(404);
    expect(res.text).toContain('Unknown template');
  });

  it('guards the mint route behind admin auth', async () => {
    const res = await request(app).post(`${BASE}/link`);
    expect(res.status).toBe(401);
  });
});
