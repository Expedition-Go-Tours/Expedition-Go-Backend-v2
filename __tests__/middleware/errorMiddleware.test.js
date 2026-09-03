jest.mock('../../utils/auditLogger', () => ({ logActivity: jest.fn(() => Promise.resolve()) }));

const errorHandler = require('../../middleware/errorMiddleware');
const AppError = require('../../utils/appError');
const { logActivity } = require('../../utils/auditLogger');

const { classifyApiError } = errorHandler;

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
  query: {},
  user: { id: 'admin-1', email: 'admin@t.com' },
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

  describe('Audit logging', () => {
    const OLD_ENV = process.env.NODE_ENV;

    beforeAll(() => { process.env.NODE_ENV = 'production'; });
    beforeEach(() => logActivity.mockClear());
    afterAll(() => { process.env.NODE_ENV = OLD_ENV; });

    it('logs 5xx API errors to the audit trail with endpoint metadata', () => {
      const res = mockRes();
      const err = new Error('DB exploded');
      err.statusCode = 500;

      errorHandler(err, req, res, jest.fn());

      expect(logActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'admin-1',
          userEmail: 'admin@t.com',
          action: 'api.error',
          resource: 'API',
          metadata: expect.objectContaining({
            statusCode: 500,
            errorName: 'Error',
            message: 'DB exploded',
            endpoint: expect.objectContaining({ method: 'GET', url: '/api/test' }),
          }),
        })
      );
    });

    it('logs 4xx operational errors', () => {
      const res = mockRes();
      const err = new AppError('Not allowed', 403);

      errorHandler(err, req, res, jest.fn());

      expect(logActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'api.error',
          metadata: expect.objectContaining({ statusCode: 403 }),
        })
      );
    });

    it('skips audit-log endpoints to avoid noise', () => {
      const res = mockRes();
      const auditReq = { ...req, originalUrl: '/api/admin/audit-log?page=1' };
      const err = new Error('boom');
      err.statusCode = 500;

      errorHandler(err, auditReq, res, jest.fn());

      expect(logActivity).not.toHaveBeenCalled();
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

    it('returns operation message for AppError', () => {
      const res = mockRes();
      const err = new AppError('Operational', 400);

      errorHandler(err, req, res, jest.fn());

      const body = res.json.mock.calls[0][0];
      expect(body.status).toBe('fail');
      expect(body.message).toBe('Operational');
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

  describe('classifyApiError (signal vs noise)', () => {
    const mkReq = (url) => ({ originalUrl: url, method: 'GET', query: {} });

    it('real: 5xx application failures', () => {
      expect(classifyApiError(mkReq('/api/bookings'), { message: 'DB exploded', statusCode: 500 }, 500)).toBe('real');
    });

    it('auth: 401 rejections', () => {
      expect(classifyApiError(mkReq('/api/auth/refresh'), { message: 'Token expired', statusCode: 401 }, 401)).toBe('auth');
    });

    it('business: intentional controller 4xx (e.g. supplier app 404)', () => {
      const err = new AppError('No supplier application found', 404);
      expect(classifyApiError(mkReq('/api/suppliers/application/status'), err, 404)).toBe('business');
    });

    it('null: probe/noise paths are not recorded', () => {
      for (const path of ['/dns-query', '/query', '/resolve', '/owa/auth/logon.aspx', '/Dr0v', '/ui/login/', '/favicon.ico', '/.env']) {
        expect(classifyApiError(mkReq(path), { message: 'boom', statusCode: 404 }, 404)).toBeNull();
      }
    });

    it('null: catch-all route-miss 404 is not recorded', () => {
      const err = new AppError("Can't find /nope on this server!", 404);
      expect(classifyApiError(mkReq('/nope'), err, 404)).toBeNull();
    });
  });
});
