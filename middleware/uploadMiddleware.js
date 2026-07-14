const { imageUpload, documentUpload } = require('../config/cloudinary');

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

exports.uploadUserPhoto = wrapMulter(imageUpload.single('photo'));

exports.uploadTourPhotos = wrapMulter(imageUpload.array('photos', 20));

exports.uploadReviewPhotos = wrapMulter(imageUpload.array('photos', 10));

exports.uploadSupplierDocuments = wrapMulter(documentUpload.fields([
  { name: 'registrationDocument', maxCount: 1 },
  { name: 'taxDocument', maxCount: 1 },
  { name: 'proofOfAddress', maxCount: 1 },
  { name: 'idDocument', maxCount: 1 },
  { name: 'licenses', maxCount: 5 },
]));

exports.uploadChatImage = wrapMulter(imageUpload.single('file'));

exports.uploadSupplierLogo = wrapMulter(imageUpload.single('logo'));

exports.uploadBlogImage = wrapMulter(imageUpload.single('image'));
