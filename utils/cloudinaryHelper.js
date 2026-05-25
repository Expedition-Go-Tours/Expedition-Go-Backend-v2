const cloudinary = require('cloudinary').v2;

function extractPublicIdFromUrl(photoUrl) {
  if (typeof photoUrl !== 'string' || photoUrl.length === 0) return null;

  // Typical Cloudinary URL shape:
  // https://res.cloudinary.com/<cloud_name>/image/upload/v169.../folder/file.ext
  const uploadMarker = '/upload/';
  const markerIndex = photoUrl.indexOf(uploadMarker);
  if (markerIndex === -1) return null;

  const afterUpload = photoUrl.slice(markerIndex + uploadMarker.length);

  // afterUpload example: v1699999999/folder/file.jpg
  const parts = afterUpload.split('/');

  if (parts.length < 2) return null;

  // If first segment is a version (v<digits>), drop it.
  const first = parts[0];
  const isVersion = /^v\d+$/i.test(first);
  const publicIdParts = isVersion ? parts.slice(1) : parts;

  if (publicIdParts.length < 2) return null;

  // Join and strip extension from last segment.
  const last = publicIdParts[publicIdParts.length - 1];
  const lastWithoutExt = last.replace(/\.[^/.]+$/, '');

  publicIdParts[publicIdParts.length - 1] = lastWithoutExt;

  return publicIdParts.join('/');
}

async function deleteCloudinaryImage(photoUrl) {
  const publicId = extractPublicIdFromUrl(photoUrl);

  // If we can't determine public_id, we can't delete reliably.
  if (!publicId) {
     
    console.warn('Cloudinary delete: could not extract public_id from photoURL. Skipping delete.', {
      photoUrl,
    });
    return;
  }

  try {
    await cloudinary.uploader.destroy(publicId);
  } catch (err) {
     
    console.warn('Cloudinary delete failed (non-fatal):', err?.message || err);
  }
}

module.exports = { deleteCloudinaryImage };
