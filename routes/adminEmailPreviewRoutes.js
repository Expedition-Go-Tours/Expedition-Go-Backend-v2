/**
 * Admin transactional-email preview gallery.
 *
 *   POST /api/admin/email-previews/link    mint a signed gallery URL (admin auth)
 *   GET  /api/admin/email-previews         the gallery page (signed token)
 *   GET  /api/admin/email-previews/template/:key   one rendered email (signed token)
 *
 * The gallery has to open in a plain browser (no Authorization header), so the
 * read routes are gated by a short-lived HMAC token minted by the admin-only
 * `/link` route rather than the admin JWT. Mounted BEFORE the main admin router
 * (whose `router.use(protect)` would otherwise reject the token-only reads).
 *
 * Each read route overrides helmet's strict default CSP: the gallery frames
 * same-origin previews and the previews load Cloudinary images.
 */

const express = require('express');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const previews = require('../src/core/services/emailPreviews');

const router = express.Router();

// Gallery shell: frames same-origin previews, no external anything.
const GALLERY_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "frame-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

// A single email: inline styles + Cloudinary images, frameable by the gallery.
const TEMPLATE_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src https: data:",
  "font-src https: data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join('; ');

function sendHtml(res, html, csp, frameOptions, status = 200) {
  res.setHeader('Content-Security-Policy', csp);
  if (frameOptions) res.setHeader('X-Frame-Options', frameOptions);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.status(status).type('html').send(html);
}

function noticePage(title, message) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title></head>
<body style="margin:0;padding:48px;font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#f8fafc;color:#334155;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:28px;">
    <h1 style="margin:0 0 8px;font-size:18px;color:#001F3F;">${title}</h1>
    <p style="margin:0;color:#475569;">${message}</p>
  </div>
</body></html>`;
}

/** Verify the request's ?token=; on failure send a notice and return null. */
function authorize(req, res) {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const verified = previews.verifyPreviewToken(token);
  if (!verified) {
    sendHtml(
      res,
      noticePage('Preview link expired', 'This link is invalid or has expired. Ask an admin to generate a new one.'),
      GALLERY_CSP,
      'DENY',
      403,
    );
    return null;
  }
  return token;
}

/**
 * @swagger
 * /admin/email-previews/link:
 *   post:
 *     summary: Mint a short-lived signed link to the transactional-email gallery
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Signed gallery URL
 *       503:
 *         description: Signing secret not configured
 */
router.post('/link', protect, restrictTo('admin'), (req, res) => {
  const token = previews.signPreviewToken();
  if (!token) {
    return res.status(503).json({
      status: 'error',
      message: 'Email preview signing is not configured (set JWT_SECRET or EMAIL_PREVIEW_TOKEN_SECRET).',
    });
  }
  const ttlMs = previews.previewTtlMs();
  const url = `${req.protocol}://${req.get('host')}/api/admin/email-previews?token=${encodeURIComponent(token)}`;
  res.json({
    status: 'success',
    data: { url, expiresAt: new Date(Date.now() + ttlMs).toISOString(), ttlMs },
  });
});

// Gallery page.
router.get('/', (req, res) => {
  const token = authorize(req, res);
  if (!token) return;

  const keys = previews.listTemplateKeys();
  const q = encodeURIComponent(token);
  const srcFor = (key) => `/api/admin/email-previews/template/${encodeURIComponent(key)}?token=${q}`;
  const html = previews.buildGallery(keys, {
    srcFor,
    linkFor: srcFor,
    // "Updated" badges are change-set specific; not meaningful for a long-lived
    // admin link, so leave them off here.
    changed: new Set(),
    title: 'Transactional email previews',
    lede: `${keys.length} templates rendered with sample data. This link expires shortly and can be regenerated from the admin dashboard.`,
  });
  sendHtml(res, html, GALLERY_CSP, 'DENY');
});

// One rendered email (framed by the gallery).
router.get('/template/:key', (req, res) => {
  const token = authorize(req, res);
  if (!token) return;

  const { key } = req.params;
  if (!previews.listTemplateKeys().includes(key)) {
    sendHtml(res, noticePage('Unknown template', 'That template does not exist.'), GALLERY_CSP, 'DENY', 404);
    return;
  }
  sendHtml(res, previews.renderTemplateDoc(key), TEMPLATE_CSP, 'SAMEORIGIN');
});

module.exports = router;
