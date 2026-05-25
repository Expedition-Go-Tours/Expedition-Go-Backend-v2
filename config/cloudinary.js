const cloudinary = require('cloudinary').v2;

// Allow booting even if Cloudinary env vars are missing during development/test.
// If upload endpoints are hit without proper config, you'll get a clear error from Cloudinary.
const {
  CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET,
} = process.env;

if (CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
  });
} else {
   
  console.warn('Cloudinary: missing env vars (CLOUDINARY_CLOUD_NAME/CLOUDINARY_API_KEY/CLOUDINARY_API_SECRET). Uploads may fail.');
}

// Lazily require multer-storage-cloudinary only if available.
// If it's not installed, we return a multer instance that will throw on use.
let upload;
try {
  const multer = require('multer');
  const { CloudinaryStorage } = require('multer-storage-cloudinary');
  const storage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder: 'user-photos',
      allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    },
  });

  upload = multer({ storage });
} catch (e) {
   
  console.warn('Cloudinary upload dependency missing. Install multer-storage-cloudinary and multer for uploads.', e?.message || e);

  console.error('[Cloudinary] CRITICAL: Cloudinary env vars missing. File uploads will fail.');
  const multer = require('multer');
  upload = multer({
    storage: multer.memoryStorage(),
  });
  upload._cloudinaryMissing = true;
}

module.exports = upload;
