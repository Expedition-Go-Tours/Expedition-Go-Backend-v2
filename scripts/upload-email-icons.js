#!/usr/bin/env node
/**
 * Upload the transactional-email line icons to Cloudinary.
 *
 * Why: Gmail and Outlook strip inline `<svg>`, so the Key-facts cards in
 * `statGrid()` reference these as PNG images instead. The source SVGs are
 * white-stroke glyphs designed to sit on the solid accent badges, and
 * Cloudinary rasterises them on delivery (`f_png`) at 40px for a 20px render
 * slot — i.e. 2x on retina.
 *
 * Idempotent: each icon uploads under a fixed public_id with `overwrite`, so
 * re-running replaces the asset instead of duplicating it. The printed URLs
 * are versionless so the constant in EMAIL_ICON_URLS stays valid across
 * re-uploads.
 *
 * Source: sendgrid-templates/assets/email-icons/*.svg
 *
 * Usage: node scripts/upload-email-icons.js
 */

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
dotenv.config({ path: './.env' });

const { cloudinary, isConfigured } = require('../config/cloudinary');

const FOLDER = 'email-icons';
const SRC_DIR = path.join(__dirname, '..', 'sendgrid-templates', 'assets', 'email-icons');
const ICON_NAMES = ['calendar', 'clock', 'duration', 'users'];

/** SVG -> 2x PNG delivery URL, versionless so it survives re-uploads. */
function pngUrl(secureUrl) {
  return secureUrl
    .replace('/upload/', '/upload/f_png,w_40,h_40,c_fit,q_95/')
    .replace(/\/v\d+\//, '/');
}

async function main() {
  if (!isConfigured) {
    console.error(
      '[email-icons] Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET in .env.'
    );
    process.exit(1);
  }

  for (const name of ICON_NAMES) {
    const file = path.join(SRC_DIR, `${name}.svg`);
    if (!fs.existsSync(file)) {
      console.error(`[email-icons] missing source icon: ${file}`);
      process.exit(1);
    }
  }

  const printed = [];
  for (const name of ICON_NAMES) {
    const file = path.join(SRC_DIR, `${name}.svg`);
    const res = await cloudinary.uploader.upload(file, {
      folder: FOLDER,
      public_id: name,
      overwrite: true,
      invalidate: true,
      resource_type: 'image',
    });
    const url = pngUrl(res.secure_url);
    printed.push(`  ${name}: '${url}',`);
    console.log(`[email-icons] uploaded ${name} -> ${res.secure_url}`);
  }

  console.log('\n[email-icons] paste into EMAIL_ICON_URLS (scripts/emailTemplateBuilder.js):');
  for (const line of printed) console.log(line);
  process.exit(0);
}

main().catch((err) => {
  console.error('[email-icons] upload failed:', err && err.message ? err.message : err);
  process.exit(1);
});
