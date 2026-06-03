const cloudinary = require('cloudinary').v2;

function extractPublicIdFromUrl(photoUrl) {
  if (typeof photoUrl !== 'string' || photoUrl.length === 0) return null;

  const uploadMarker = '/upload/';
  const markerIndex = photoUrl.indexOf(uploadMarker);
  if (markerIndex === -1) return null;

  const afterUpload = photoUrl.slice(markerIndex + uploadMarker.length);

  // Cloudinary URL after /upload/ can be:
  //   w_1400,q_80,f_auto/v123/user-photos/abc.jpg  (with transformations)
  //   v123/user-photos/abc.jpg                       (no transformations)
  //   user-photos/abc.jpg                            (no version)
  // Skip transformation segments (contain underscores and are NOT the version)
  // then skip the optional version segment (v<digits>).
  const parts = afterUpload.split('/');

  // Find the first segment that is NOT a transformation or version
  let publicIdStart = 0;
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (/^v\d+$/i.test(seg)) {
      // skip version segment
      publicIdStart = i + 1;
      break;
    }
    // If this segment doesn't contain an underscore, it's the start of the public ID
    if (!seg.includes('_')) {
      publicIdStart = i;
      break;
    }
    // Otherwise, it's a transformation segment — skip it
  }

  const publicIdParts = parts.slice(publicIdStart);

  if (publicIdParts.length < 2) return null;

  // Strip extension from last segment
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
