jest.mock('../../config/cloudinary', () => ({
  single: jest.fn(),
  array: jest.fn(),
  fields: jest.fn(),
}));

describe('uploadMiddleware', () => {
  let req, res, next, upload, middleware;

  function setupMocks() {
    upload = require('../../config/cloudinary');
    upload.single.mockReturnValue((req, res, cb) => cb(null));
    upload.array.mockReturnValue((req, res, cb) => cb(null));
    upload.fields.mockReturnValue((req, res, cb) => cb(null));
    jest.isolateModules(() => {
      middleware = require('../../middleware/uploadMiddleware');
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    setupMocks();
    req = {};
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    next = jest.fn();
  });

  it('uploadUserPhoto calls upload.single with photo', () => {
    middleware.uploadUserPhoto(req, res, next);
    expect(upload.single).toHaveBeenCalledWith('photo');
  });

  it('uploadTourPhotos calls upload.array with photos and 20', () => {
    middleware.uploadTourPhotos(req, res, next);
    expect(upload.array).toHaveBeenCalledWith('photos', 20);
  });

  it('uploadReviewPhotos calls upload.array with photos and 10', () => {
    middleware.uploadReviewPhotos(req, res, next);
    expect(upload.array).toHaveBeenCalledWith('photos', 10);
  });

  it('uploadSupplierDocuments calls upload.fields with correct fields', () => {
    middleware.uploadSupplierDocuments(req, res, next);
    expect(upload.fields).toHaveBeenCalledWith([
      { name: 'registrationDocument', maxCount: 1 },
      { name: 'taxDocument', maxCount: 1 },
      { name: 'proofOfAddress', maxCount: 1 },
      { name: 'idDocument', maxCount: 1 },
      { name: 'licenses', maxCount: 5 },
    ]);
  });

  it('uploadChatImage calls upload.single with file', () => {
    middleware.uploadChatImage(req, res, next);
    expect(upload.single).toHaveBeenCalledWith('file');
  });

  it('uploadSupplierLogo calls upload.single with logo', () => {
    middleware.uploadSupplierLogo(req, res, next);
    expect(upload.single).toHaveBeenCalledWith('logo');
  });

  it('returns 400 when multer passes an error', () => {
    jest.isolateModules(() => {
      const upload = require('../../config/cloudinary');
      upload.single.mockReturnValue((req, res, cb) => cb(new Error('Invalid file type')));
      const middleware = require('../../middleware/uploadMiddleware');
      middleware.uploadUserPhoto(req, res, next);
    });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ status: 'fail', message: 'Invalid file type' });
  });
});
