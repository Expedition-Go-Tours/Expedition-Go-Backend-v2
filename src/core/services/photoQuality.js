/**
 * Upload-time photo quality gate.
 *
 * The supplier builder has always told people "landscape, minimum 1280px wide"
 * in its tips panel, but nothing checked it — 9 of 14 sampled live tour photos
 * were under 1280px wide and two were portrait. A portrait or thumbnail-sized
 * file is what ends up blurred into a storefront tile, so the rule is enforced
 * here as well as in the browser: the client gives instant feedback, this is the
 * backstop for anyone posting straight to the API.
 *
 * The thresholds match the rendered sizes: a phone tile is 366px (≈1100 at 3×)
 * and the desktop hero column is ~816px (≈1630 at 2×).
 */

const { cloudinary, isConfigured } = require('../../../config/cloudinary');
const { extractPublicIdFromUrl, deleteCloudinaryImage } = require('./cloudinaryHelper');

const MIN_PHOTO_WIDTH = 1280;
const IDEAL_PHOTO_WIDTH = 2048;

/**
 * Pure verdict for a width/height pair, so the rule can be tested without
 * touching Cloudinary.
 */
function assessDimensions(input) {
  const { width, height } = input || {};
  const w = Number(width) || 0;
  const h = Number(height) || 0;

  if (!w || !h) {
    return { ok: false, width: w, height: h, reason: 'The image size could not be read.' };
  }

  if (h > w) {
    return {
      ok: false,
      width: w,
      height: h,
      reason: `Portrait isn't supported (${w}\u00d7${h}). Use a landscape photo.`,
    };
  }

  if (w < MIN_PHOTO_WIDTH) {
    return {
      ok: false,
      width: w,
      height: h,
      reason: `Too small (${w}\u00d7${h}). Use a photo at least ${MIN_PHOTO_WIDTH}px wide.`,
    };
  }

  return { ok: true, width: w, height: h, lowRes: w < IDEAL_PHOTO_WIDTH };
}

/**
 * Read the stored asset's real dimensions and, when it fails, delete it so a
 * rejected upload never lingers in the media library.
 */
async function assessUploadedPhoto(url) {
  // No Cloudinary (local/dev without credentials): nothing to verify against,
  // so do not block the upload.
  if (!isConfigured) return { ok: true, width: 0, height: 0, skipped: true };

  const publicId = extractPublicIdFromUrl(url);
  if (!publicId) return { ok: false, width: 0, height: 0, reason: 'Unrecognised image URL.' };

  let resource;
  try {
    resource = await cloudinary.api.resource(publicId, { resource_type: 'image' });
  } catch {
    return { ok: false, width: 0, height: 0, reason: 'The uploaded image could not be verified. Please try again.' };
  }

  const verdict = assessDimensions(resource);
  if (!verdict.ok) {
    await deleteCloudinaryImage(url).catch(() => {});
  }
  return verdict;
}

module.exports = { assessDimensions, assessUploadedPhoto, MIN_PHOTO_WIDTH, IDEAL_PHOTO_WIDTH };
