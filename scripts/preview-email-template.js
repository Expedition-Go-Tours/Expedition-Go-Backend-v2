/**
 * Email template preview — renders one compiled template with realistic sample
 * data and writes a standalone HTML file you can open in a browser. No email
 * is sent and no DB/queue is touched.
 *
 * The sample data + renderer live in src/core/services/emailPreviews.js (shared
 * with the admin gallery endpoint); this script is just the local-file CLI.
 *
 * Usage:
 *   node scripts/preview-email-template.js supplier-reserve-later
 *   node scripts/preview-email-template.js booking-confirmed
 *
 * The output path is printed on the last line.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { SHELL, SAMPLE, renderTemplateDoc } = require('../src/core/services/emailPreviews');

const OUT_DIR = path.join(os.tmpdir(), 'opencode');

function renderTemplate(key) {
  const html = renderTemplateDoc(key);

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `${key}-preview.html`);
  fs.writeFileSync(out, html, 'utf-8');
  return out;
}

function main() {
  const key = process.argv[2] || 'supplier-reserve-later';
  let out;
  try {
    out = renderTemplate(key);
  } catch (err) {
    console.error(err.message);
    console.error(`Known keys: ${(err.knownKeys || []).join(', ')}`);
    process.exit(1);
  }

  console.log(`[Preview] ${key} → ${out}`);
  return out;
}

module.exports = { SHELL, SAMPLE, OUT_DIR, renderTemplate, main };

if (require.main === module) main();
