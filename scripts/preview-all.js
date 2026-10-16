/**
 * Render every transactional email template with sample data and write a
 * standalone gallery page (index.html) that embeds each preview in an iframe.
 * No email is sent and no DB/queue is touched.
 *
 * The gallery builder lives in src/core/services/emailPreviews.js (shared with
 * the admin gallery endpoint); this script is just the local-file CLI.
 *
 * Usage:
 *   node scripts/preview-all.js
 *
 * The gallery path is printed on the last line. Serve OUT_DIR over HTTP (the
 * previews and gallery are plain static files) and open index.html.
 */

const fs = require('fs');
const path = require('path');

const { TEMPLATE_DEFS } = require('./buildEmailTemplates');
const { OUT_DIR, renderTemplate } = require('./preview-email-template');
const { buildGallery, groupFor, titleize, CHANGED } = require('../src/core/services/emailPreviews');

function main() {
  const keys = TEMPLATE_DEFS.map((d) => d.key);
  for (const key of keys) renderTemplate(key);

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, 'index.html');
  fs.writeFileSync(out, buildGallery(keys), 'utf-8');

  console.log(`[Gallery] ${keys.length} templates → ${out}`);
  return out;
}

module.exports = { buildGallery, groupFor, titleize, CHANGED };

if (require.main === module) main();
