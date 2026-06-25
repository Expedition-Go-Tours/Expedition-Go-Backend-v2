const cloudinary = require('cloudinary').v2;

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

async function deleteCloudinaryImage(photoUrl, retries = 3) {
  const publicId = extractPublicIdFromUrl(photoUrl);

  if (!publicId) {
    console.warn('Cloudinary delete: could not extract public_id from photoURL. Skipping.', { photoUrl });
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

module.exports = { deleteCloudinaryImage, extractPublicIdFromUrl, isValidCloudinaryUrl };
