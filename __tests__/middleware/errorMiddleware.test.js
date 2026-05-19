const errorHandler = require('../../middleware/errorMiddleware');
const AppError = require('../../utils/appError');

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.header = jest.fn().mockReturnValue(res);
  return res;
};

const req = {
  originalUrl: '/api/test',
  method: 'GET',
  ip: '127.0.0.1',
  headers: { origin: 'http://localhost:3000' },
};

describe('Error Middleware', () => {
  describe('Production mode', () => {
    const OLD_ENV = process.env.NODE_ENV;

    beforeAll(() => { process.env.NODE_ENV = 'production'; });
    afterAll(() => { process.env.NODE_ENV = OLD_ENV; });

    it('hides stack trace in production', () => {
      const res = mockRes();
      const err = new Error('Something went wrong');
      err.statusCode = 500;

      errorHandler(err, req, res, jest.fn());

      expect(res.status).toHaveBeenCalledWith(500);
      const body = res.json.mock.calls[0][0];
      expect(body.status).toBe('error');
      expect(body.stack).toBeUndefined();
    });

    it('shows AppError message in production', () => {
      const res = mockRes();
      const err = new AppError('Custom error message', 400);

      errorHandler(err, req, res, jest.fn());

      expect(res.status).toHaveBeenCalledWith(400);
      const body = res.json.mock.calls[0][0];
      expect(body.message).toBe('Custom error message');
    });

    it('returns generic message for programming errors in production', () => {
      const res = mockRes();
      const err = new Error('Internal database crash');
      err.statusCode = 500;

      errorHandler(err, req, res, jest.fn());

      expect(res.status).toHaveBeenCalledWith(500);
      const body = res.json.mock.calls[0][0];
      expect(body.message).toBe('Something went wrong!');
    });

    it('handles Prisma known request errors as 400', () => {
      const res = mockRes();
      const err = new Error('Unique constraint failed');
      err.code = 'P2002';
      err.statusCode = 500;

      errorHandler(err, req, res, jest.fn());

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('handles Prisma not-found errors as 404', () => {
      const res = mockRes();
      const err = new Error('Record not found');
      err.code = 'P2025';

      errorHandler(err, req, res, jest.fn());

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('handles JSON parse errors', () => {
      const res = mockRes();
      const err = new SyntaxError('Unexpected token < in JSON at position 0');
      err.statusCode = 500;

      errorHandler(err, req, res, jest.fn());

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('handles Multer file size errors', () => {
      const res = mockRes();
      const err = new Error('File too large');
      err.code = 'LIMIT_FILE_SIZE';

      errorHandler(err, req, res, jest.fn());

      expect(res.status).toHaveBeenCalledWith(413);
    });
  });

  describe('Development mode', () => {
    const OLD_ENV = process.env.NODE_ENV;

    beforeAll(() => { process.env.NODE_ENV = 'development'; });
    afterAll(() => { process.env.NODE_ENV = OLD_ENV; });

    it('leaks stack trace in development', () => {
      const res = mockRes();
      const err = new Error('Dev error');
      err.statusCode = 500;

      errorHandler(err, req, res, jest.fn());

      const body = res.json.mock.calls[0][0];
      expect(body.stack).toBeDefined();
      expect(body.message).toBe('Dev error');
    });
  });

  describe('response.json errors', () => {
    it('calls next if response already sent', () => {
      const res = mockRes();
      res.headersSent = true;
      const err = new Error('Late error');
      const next = jest.fn();

      errorHandler(err, req, res, next);

      expect(next).toHaveBeenCalledWith(err);
    });
  });

  describe('Error properties', () => {
    const OLD_ENV = process.env.NODE_ENV;

    beforeAll(() => { process.env.NODE_ENV = 'production'; });
    afterAll(() => { process.env.NODE_ENV = OLD_ENV; });

    it('uses 500 if no statusCode on error', () => {
      const res = mockRes();
      const err = new Error('Plain error');

      errorHandler(err, req, res, jest.fn());

      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('sets status fail for 4xx errors', () => {
      const res = mockRes();
      const err = new AppError('Validation failed', 422);

      errorHandler(err, req, res, jest.fn());

      const body = res.json.mock.calls[0][0];
      expect(body.status).toBe('fail');
    });

    it('sets status error for 5xx errors', () => {
      const res = mockRes();
      const err = new AppError('Server error', 500);

      errorHandler(err, req, res, jest.fn());

      const body = res.json.mock.calls[0][0];
      expect(body.status).toBe('error');
    });

    it('includes isOperational flag for AppError', () => {
      const res = mockRes();
      const err = new AppError('Operational', 400);

      errorHandler(err, req, res, jest.fn());

      const body = res.json.mock.calls[0][0];
      expect(body.isOperational).toBe(true);
    });
  });

  describe('CastError handling', () => {
    it('handles MongoDB-style CastError', () => {
      const res = mockRes();
      const err = new Error('Cast to ObjectId failed');
      err.name = 'CastError';

      errorHandler(err, req, res, jest.fn());

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('JWT errors', () => {
    it('handles JsonWebTokenError', () => {
      const res = mockRes();
      const err = new Error('jwt malformed');
      err.name = 'JsonWebTokenError';

      errorHandler(err, req, res, jest.fn());

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('handles TokenExpiredError', () => {
      const res = mockRes();
      const err = new Error('jwt expired');
      err.name = 'TokenExpiredError';

      errorHandler(err, req, res, jest.fn());

      expect(res.status).toHaveBeenCalledWith(401);
    });
  });
});
