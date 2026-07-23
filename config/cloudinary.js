const cloudinary = require('cloudinary').v2;

const {
  CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET,
  NODE_ENV,
} = process.env;

const isConfigured = !!(CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET);

if (isConfigured) {
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
    timeout: 10000,
  });
} else {
  const msg = 'Cloudinary: missing env vars (CLOUDINARY_CLOUD_NAME/CLOUDINARY_API_KEY/CLOUDINARY_API_SECRET). Uploads will fail.';
  if (NODE_ENV === 'production') {
    console.error(`[Cloudinary] CRITICAL: ${msg}`);
  } else {
    console.warn(msg);
  }
}

const IMAGE_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'avif'];
const DOCUMENT_FORMATS = ['pdf'];

function imageFileFilter(req, file, cb) {
  if (file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error(`File type "${file.mimetype}" is not allowed. Upload images only.`), false);
  }
}

function documentFileFilter(req, file, cb) {
  if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') {
    cb(null, true);
  } else {
    cb(new Error(`File type "${file.mimetype}" is not allowed. Upload images or PDFs only.`), false);
  }
}

function buildImageUpload() {
  const multer = require('multer');
  const { CloudinaryStorage } = require('multer-storage-cloudinary');

  const storage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder: 'user-photos',
      allowed_formats: IMAGE_FORMATS,
      resource_type: 'image',
      transformation: { quality: 'auto', fetch_format: 'auto' },
    },
  });

  return multer({
    storage,
    fileFilter: imageFileFilter,
    limits: { fileSize: 10 * 1024 * 1024, files: 20 },
  });
}

function buildDocumentUpload() {
  const multer = require('multer');
  const { CloudinaryStorage } = require('multer-storage-cloudinary');

  const storage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder: 'supplier-documents',
      allowed_formats: [...IMAGE_FORMATS, ...DOCUMENT_FORMATS],
      resource_type: 'auto',
    },
  });

  return multer({
    storage,
    fileFilter: documentFileFilter,
    limits: { fileSize: 10 * 1024 * 1024, files: 9 },
  });
}

function buildFallback() {
  const multer = require('multer');
  return multer({ storage: multer.memoryStorage() });
}

let imageUpload;
let documentUpload;

try {
  require.resolve('multer-storage-cloudinary');
  imageUpload = buildImageUpload();
  documentUpload = buildDocumentUpload();
} catch (e) {
  console.warn('multer-storage-cloudinary not found. Using memory storage fallback.', e?.message);
  imageUpload = buildFallback();
  documentUpload = buildFallback();
}

imageUpload._cloudinaryMissing = !isConfigured;
documentUpload._cloudinaryMissing = !isConfigured;

module.exports = { imageUpload, documentUpload, cloudinary, isConfigured };
