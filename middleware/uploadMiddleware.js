const upload = require('../config/cloudinary');

// Wrap multer middleware to catch Cloudinary errors (e.g. rejected format)
// and forward them to Express error handler instead of crashing the process.
function wrapMulter(middleware) {
  return (req, res, next) => {
    middleware(req, res, (err) => {
      if (err) {
        const message = err.message || 'File upload failed';
        return res.status(400).json({ status: 'fail', message });
      }
      next();
    });
  };
}

// User photo upload
exports.uploadUserPhoto = wrapMulter(upload.single('photo'));

// Tour photos upload (multiple)
exports.uploadTourPhotos = wrapMulter(upload.array('photos', 20));

// Review photos upload (multiple)
exports.uploadReviewPhotos = wrapMulter(upload.array('photos', 10));

// Supplier document uploads
exports.uploadSupplierDocuments = wrapMulter(upload.fields([
  { name: 'registrationDocument', maxCount: 1 },
  { name: 'taxDocument', maxCount: 1 },
  { name: 'proofOfAddress', maxCount: 1 },
  { name: 'idDocument', maxCount: 1 },
  { name: 'licenses', maxCount: 5 }
]));

// Chat image upload
exports.uploadChatImage = wrapMulter(upload.single('file'));