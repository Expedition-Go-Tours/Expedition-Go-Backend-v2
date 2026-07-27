const { imageUpload, documentUpload } = require('../config/cloudinary');
const prisma = require('../utils/prismaClient');
const { extractPublicIdFromUrl } = require('../utils/cloudinaryHelper');

function wrapMulter(middleware) {
  return (req, res, next) => {
    if (middleware._cloudinaryMissing) {
      return res.status(503).json({ status: 'fail', message: 'File upload service is unavailable' });
    }
    middleware(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ status: 'fail', message: 'File exceeds maximum size of 10MB' });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          return res.status(400).json({ status: 'fail', message: 'Too many files uploaded' });
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          return res.status(400).json({ status: 'fail', message: 'Unexpected file field' });
        }
        const message = err.message || 'File upload failed';
        return res.status(400).json({ status: 'fail', message });
      }
      next();
    });
  };
}

function wrapWithRecord(multerInstance) {
  const wrapped = wrapMulter(multerInstance);
  return (req, res, next) => {
    wrapped(req, res, (err) => {
      if (err) return next(err);
      recordMedia(req, res, next);
    });
  };
}

async function recordMedia(req, res, next) {
  const urls = [];
  if (req.files) {
    if (Array.isArray(req.files)) {
      req.files.forEach(f => { if (f.path) urls.push(f.path); });
    } else {
      Object.values(req.files).forEach(arr => {
        if (Array.isArray(arr)) arr.forEach(f => { if (f.path) urls.push(f.path); });
      });
    }
  } else if (req.file?.path) {
    urls.push(req.file.path);
  }

  if (urls.length > 0) {
    try {
      const records = urls.map(url => ({
        url,
        publicId: extractPublicIdFromUrl(url),
        userId: req.user?.id || null,
        status: 'PENDING',
      }));
      await prisma.media.createMany({ data: records, skipDuplicates: true });
    } catch (err) {
      console.warn('[Media] Failed to record upload:', err.message);
    }
  }
  next();
}

exports.recordMedia = recordMedia;

exports.uploadUserPhoto = wrapWithRecord(imageUpload.single('photo'));

exports.uploadTourPhotos = wrapWithRecord(imageUpload.array('photos', 20));

exports.uploadReviewPhotos = wrapWithRecord(imageUpload.array('photos', 10));

exports.uploadSupplierDocuments = wrapWithRecord(documentUpload.fields([
  { name: 'registrationDocument', maxCount: 1 },
  { name: 'taxDocument', maxCount: 1 },
  { name: 'proofOfAddress', maxCount: 1 },
  { name: 'idDocument', maxCount: 1 },
  { name: 'licenses', maxCount: 5 },
]));

exports.uploadChatImage = wrapWithRecord(imageUpload.single('file'));

exports.uploadSupplierLogo = wrapWithRecord(imageUpload.single('logo'));

exports.uploadBlogImage = wrapWithRecord(imageUpload.single('image'));
