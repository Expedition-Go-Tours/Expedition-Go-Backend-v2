jest.mock('../../config/cloudinary', () => ({
  imageUpload: {
    single: jest.fn(),
    array: jest.fn(),
    _cloudinaryMissing: false,
  },
  documentUpload: {
    fields: jest.fn(),
    _cloudinaryMissing: false,
  },
}));

describe('uploadMiddleware', () => {
  let req, res, next, config, middleware;

  function setupMocks() {
    config = require('../../config/cloudinary');
    const mockFn = (req, res, cb) => cb(null);
    mockFn._cloudinaryMissing = false;
    config.imageUpload.single.mockReturnValue(mockFn);
    config.imageUpload.array.mockReturnValue((req, res, cb) => cb(null));
    config.documentUpload.fields.mockReturnValue((req, res, cb) => cb(null));
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

  it('uploadUserPhoto calls imageUpload.single with photo', () => {
    middleware.uploadUserPhoto(req, res, next);
    expect(config.imageUpload.single).toHaveBeenCalledWith('photo');
  });

  it('uploadTourPhotos calls imageUpload.array with photos and 20', () => {
    middleware.uploadTourPhotos(req, res, next);
    expect(config.imageUpload.array).toHaveBeenCalledWith('photos', 20);
  });

  it('uploadReviewPhotos calls imageUpload.array with photos and 10', () => {
    middleware.uploadReviewPhotos(req, res, next);
    expect(config.imageUpload.array).toHaveBeenCalledWith('photos', 10);
  });

  it('uploadSupplierDocuments calls documentUpload.fields with correct fields', () => {
    middleware.uploadSupplierDocuments(req, res, next);
    expect(config.documentUpload.fields).toHaveBeenCalledWith([
      { name: 'registrationDocument', maxCount: 1 },
      { name: 'taxDocument', maxCount: 1 },
      { name: 'proofOfAddress', maxCount: 1 },
      { name: 'idDocument', maxCount: 1 },
      { name: 'licenses', maxCount: 5 },
    ]);
  });

  it('uploadChatImage calls imageUpload.single with file', () => {
    middleware.uploadChatImage(req, res, next);
    expect(config.imageUpload.single).toHaveBeenCalledWith('file');
  });

  it('uploadSupplierLogo calls imageUpload.single with logo', () => {
    middleware.uploadSupplierLogo(req, res, next);
    expect(config.imageUpload.single).toHaveBeenCalledWith('logo');
  });

  it('returns 400 when multer passes an error', () => {
    jest.isolateModules(() => {
      const config = require('../../config/cloudinary');
      config.imageUpload.single.mockReturnValue((req, res, cb) => cb(new Error('Invalid file type')));
      const middleware = require('../../middleware/uploadMiddleware');
      middleware.uploadUserPhoto(req, res, next);
    });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ status: 'fail', message: 'Invalid file type' });
  });

  it('returns 400 for file size limit error', () => {
    jest.isolateModules(() => {
      const config = require('../../config/cloudinary');
      const err = new Error('File too large');
      err.code = 'LIMIT_FILE_SIZE';
      config.imageUpload.single.mockReturnValue((req, res, cb) => cb(err));
      const middleware = require('../../middleware/uploadMiddleware');
      middleware.uploadUserPhoto(req, res, next);
    });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ status: 'fail', message: 'File exceeds maximum size of 10MB' });
  });

  it('returns 503 when cloudinary is missing', () => {
    jest.isolateModules(() => {
      const config = require('../../config/cloudinary');
      const mockSingleFn = (req, res, cb) => cb(null);
      mockSingleFn._cloudinaryMissing = true;
      config.imageUpload.single.mockReturnValue(mockSingleFn);
      const middleware = require('../../middleware/uploadMiddleware');
      middleware.uploadUserPhoto(req, res, next);
    });
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ status: 'fail', message: 'File upload service is unavailable' });
  });
});
