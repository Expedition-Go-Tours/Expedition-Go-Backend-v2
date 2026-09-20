const cloudinary = require('cloudinary').v2;
const prisma = require('./prismaClient');

function extractPublicIdFromUrl(photoUrl) {
  if (typeof photoUrl !== 'string' || photoUrl.length === 0) return null;

  const uploadMarker = '/upload/';
  const markerIndex = photoUrl.indexOf(uploadMarker);
  if (markerIndex === -1) return null;

  const afterUpload = photoUrl.slice(markerIndex + uploadMarker.length);

  const parts = afterUpload.split('/');

  let publicIdStart = 0;
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (/^v\d+$/i.test(seg)) {
      publicIdStart = i + 1;
      break;
    }
    if (!seg.includes('_')) {
      publicIdStart = i;
      break;
    }
  }

  const publicIdParts = parts.slice(publicIdStart);

  if (publicIdParts.length < 2) return null;

  const last = publicIdParts[publicIdParts.length - 1];
  const lastWithoutExt = last.replace(/\.[^/.]+$/, '');

  publicIdParts[publicIdParts.length - 1] = lastWithoutExt;

  return publicIdParts.join('/');
}

function isValidCloudinaryUrl(url) {
  if (typeof url !== 'string') return false;
  return /^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\//.test(url);
}

// Check whether a Cloudinary URL is still referenced by any live record.
// `exclude` lets the record being edited opt out of the check so that
// intentionally-replaced assets can still be deleted.
async function isUrlReferenced(url, exclude = {}) {
  if (typeof url !== 'string' || url.length === 0) return false;

  const checks = [
    prisma.tour.findFirst({
      where: {
        ...(exclude.tourId ? { id: { not: exclude.tourId } } : {}),
        OR: [{ coverPhoto: url }, { photos: { has: url } }],
      },
      select: { id: true },
    }).then((row) => !!row),

    prisma.user.findFirst({
      where: {
        ...(exclude.userId ? { id: { not: exclude.userId } } : {}),
        OR: [{ photoURL: url }, { logoUrl: url }],
      },
      select: { id: true },
    }).then((row) => !!row),

    prisma.review.findFirst({
      where: {
        ...(exclude.reviewId ? { id: { not: exclude.reviewId } } : {}),
        photos: { has: url },
      },
      select: { id: true },
    }).then((row) => !!row),

    prisma.article.findFirst({
      where: { featuredImage: url },
      select: { id: true },
    }).then((row) => !!row),

    prisma.message.findFirst({
      where: { attachmentUrl: url },
      select: { id: true },
    }).then((row) => !!row),
  ];

  const results = await Promise.all(checks);
  return results.some(Boolean);
}

async function deleteCloudinaryImage(photoUrl, retries = 3, exclude = {}) {
  const publicId = extractPublicIdFromUrl(photoUrl);

  if (!publicId) {
    console.warn('Cloudinary delete: could not extract public_id from photoURL. Skipping.', { photoUrl });
    return;
  }

  // Safety guard: never destroy an asset that is still referenced. If the
  // reference check itself fails (DB unavailable), fail CLOSED and keep the
  // asset rather than risk deleting something still in use.
  let referenced;
  try {
    referenced = await isUrlReferenced(photoUrl, exclude);
  } catch (err) {
    console.warn('Cloudinary delete skipped: reference check failed.', { photoUrl, publicId, error: err?.message || err });
    return;
  }

  if (referenced) {
    console.warn('Cloudinary delete skipped: asset is still referenced.', { photoUrl, publicId });
    return;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await cloudinary.uploader.destroy(publicId);
      return;
    } catch (err) {
      const isLastAttempt = attempt === retries;
      if (isLastAttempt) {
        console.warn('Cloudinary delete failed after retries:', err?.message || err, { photoUrl, publicId, attempt });
      } else {
        await new Promise(r => setTimeout(r, attempt * 1000));
      }
    }
  }
}

module.exports = { deleteCloudinaryImage, extractPublicIdFromUrl, isValidCloudinaryUrl, isUrlReferenced };
