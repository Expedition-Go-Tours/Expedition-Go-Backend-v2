const upload = require('../config/cloudinary');

// User photo upload
exports.uploadUserPhoto = upload.single('photo');

// Tour photos upload (multiple)
exports.uploadTourPhotos = upload.array('photos', 20);

// Review photos upload (multiple)
exports.uploadReviewPhotos = upload.array('photos', 10);

// Supplier document uploads
exports.uploadSupplierDocuments = upload.fields([
  { name: 'registrationDocument', maxCount: 1 },
  { name: 'taxDocument', maxCount: 1 },
  { name: 'proofOfAddress', maxCount: 1 },
  { name: 'idDocument', maxCount: 1 },
  { name: 'licenses', maxCount: 5 }
]);