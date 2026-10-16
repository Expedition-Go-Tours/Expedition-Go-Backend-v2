/**
 * Build ONE self-contained HTML file with every email preview embedded, so it
 * can be sent to anyone (email, AirDrop, Slack, Drive) and opened on their
 * device with no server and no local files.
 *
 * Each preview is inlined as a base64 `data:` iframe source, so the single
 * file works from `file://` and needs no network for the page itself (the tour
 * photos inside the emails still load from Cloudinary, so an internet
 * connection makes the previews look their best).
 *
 * Usage:
 *   node scripts/preview-share.js
 *
 * The output path and size are printed on the last lines.
 */

const fs = require('fs');
const path = require('path');

const { TEMPLATE_DEFS } = require('./buildEmailTemplates');
const { OUT_DIR, renderTemplate } = require('./preview-email-template');
const { buildGallery } = require('./preview-all');

function main() {
  const keys = TEMPLATE_DEFS.map((d) => d.key);

  const dataUris = {};
  for (const key of keys) {
    const file = renderTemplate(key);
    const html = fs.readFileSync(file, 'utf8');
    dataUris[key] = `data:text/html;base64,${Buffer.from(html, 'utf8').toString('base64')}`;
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, 'preview-gallery.html');
  const page = buildGallery(keys, {
    srcFor: (key) => dataUris[key],
    // A data: URL cannot be opened as a top-level tab, so no per-card link.
    linkFor: () => null,
    title: 'Transactional email previews',
    lede: `${keys.length} templates rendered with sample data. This file is self-contained: open it on any device, no server needed.`,
  });
  fs.writeFileSync(out, page, 'utf8');

  const mb = (fs.statSync(out).size / 1024 / 1024).toFixed(2);
  console.log(`[Share] ${keys.length} templates → ${out}`);
  console.log(`Size: ${mb} MB (single file, send as-is)`);
  return out;
}

module.exports = { main };

if (require.main === module) main();
