/**
 * Photo audit for the existing catalogue.
 *
 * The upload gate only protects new photos. This walks what is already stored
 * and reports the ones that render soft or crop badly, so they can be replaced
 * instead of silently dragging down every card they appear on.
 *
 * Dimensions are read from Cloudinary and cached: an uploaded asset never
 * changes size, so a public id is measured once.
 */

const { cloudinary, isConfigured } = require('../../../config/cloudinary');
const { extractPublicIdFromUrl } = require('./cloudinaryHelper');

const MIN_PHOTO_WIDTH = 1280;
const IDEAL_PHOTO_WIDTH = 2048;

// An uploaded asset never changes size, so a public id is measured once. Kept
// in-process on purpose: this runs as a batch job, and going through Redis here
// adds a failure mode with nothing to gain.
const dimensionCache = new Map();
const DIMENSION_CACHE_MAX = 5000;
const REQUEST_TIMEOUT_MS = 10000;

/** The rule itself, kept pure so it can be tested without Cloudinary. */
function classifyPhoto(input) {
  const { width, height } = input || {};
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (!w || !h) return null;
  if (h > w) return { problem: 'portrait', width: w, height: h };
  if (w < MIN_PHOTO_WIDTH) return { problem: 'too-small', width: w, height: h };
  if (w < IDEAL_PHOTO_WIDTH) return { problem: 'soft-on-desktop', width: w, height: h };
  return null;
}

async function dimensionsFor(url) {
  const publicId = extractPublicIdFromUrl(url);
  if (!publicId) return null;

  if (dimensionCache.has(publicId)) return dimensionCache.get(publicId);

  let dims = null;
  try {
    const resource = await cloudinary.api.resource(publicId, {
      resource_type: 'image',
      timeout: REQUEST_TIMEOUT_MS,
    });
    dims = { width: Number(resource.width) || 0, height: Number(resource.height) || 0 };
  } catch {
    dims = null;
  }

  if (dimensionCache.size < DIMENSION_CACHE_MAX) dimensionCache.set(publicId, dims);
  return dims;
}

async function mapLimit(items, limit, fn) {
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Audit a tour's photos. Bounded on purpose: a live request must not fan out to
 * a hundred Cloudinary calls, and a tour's first photos are the ones that
 * render.
 */
async function auditTourPhotos(tour, { perTourLimit = 8, concurrency = 6 } = {}) {
  const urls = [...new Set([tour.coverPhoto, ...(tour.photos || [])].filter(Boolean))];

  if (!isConfigured) {
    return { tourId: tour.id, title: tour.title, issues: [], checked: 0, skipped: urls.length, unavailable: true };
  }

  const sample = urls.slice(0, perTourLimit);

  const results = await mapLimit(sample, concurrency, async (url) => {
    const dims = await dimensionsFor(url);
    if (!dims) return { url, status: 'unknown' };
    const verdict = classifyPhoto(dims);
    return verdict
      ? { url, status: 'issue', ...verdict }
      : { url, status: 'ok', ...dims };
  });

  return {
    tourId: tour.id,
    title: tour.title,
    slug: tour.slug,
    issues: results.filter((r) => r.status === 'issue'),
    checked: results.filter((r) => r.status !== 'unknown').length,
    unknown: results.filter((r) => r.status === 'unknown').length,
    skipped: urls.length - sample.length,
  };
}

module.exports = {
  auditTourPhotos,
  classifyPhoto,
  dimensionsFor,
  MIN_PHOTO_WIDTH,
  IDEAL_PHOTO_WIDTH,
};
