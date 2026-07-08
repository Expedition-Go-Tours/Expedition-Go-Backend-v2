jest.mock('../../utils/prismaClient', () => ({
  user: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
}));

jest.mock('../../utils/queue', () => ({
  enqueueEvent: jest.fn(() => Promise.resolve()),
  enqueueCreateStripeCustomer: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../utils/refreshTokenHelper', () => ({
  storeRefreshToken: jest.fn(() => Promise.resolve()),
  rotateRefreshToken: jest.fn(),
  clearRefreshToken: jest.fn(() => Promise.resolve()),
}));

const mockSignAccessToken = jest.fn();
const mockSignRefreshToken = jest.fn();
const mockSignPasswordResetToken = jest.fn();
const mockVerifyPasswordResetToken = jest.fn();
const mockVerifyAccessToken = jest.fn();
const mockVerifyRefreshToken = jest.fn();
const mockSetAuthCookies = jest.fn();
const mockClearAuthCookies = jest.fn();

jest.mock('../../config/jwt', () => ({
  signAccessToken: (...args) => mockSignAccessToken(...args),
  signRefreshToken: (...args) => mockSignRefreshToken(...args),
  signPasswordResetToken: (...args) => mockSignPasswordResetToken(...args),
  verifyPasswordResetToken: (...args) => mockVerifyPasswordResetToken(...args),
  verifyAccessToken: (...args) => mockVerifyAccessToken(...args),
  verifyRefreshToken: (...args) => mockVerifyRefreshToken(...args),
  setAuthCookies: (...args) => mockSetAuthCookies(...args),
  clearAuthCookies: (...args) => mockClearAuthCookies(...args),
}));

jest.mock('bcrypt', () => ({
  hash: jest.fn(() => Promise.resolve('hashed-password')),
  compare: jest.fn(),
}));

jest.mock('passport', () => ({
  authenticate: jest.fn(),
}));

jest.mock('../../utils/emailService', () => ({ sendEmail: jest.fn(() => Promise.resolve()) }));

const bcrypt = require('bcrypt');
const passport = require('passport');
const prisma = require('../../utils/prismaClient');
const { enqueueEvent, enqueueCreateStripeCustomer } = require('../../utils/queue');
const { storeRefreshToken, rotateRefreshToken, clearRefreshToken } = require('../../utils/refreshTokenHelper');

const controller = require('../../controllers/authController');

const mockUser = {
  id: 'user-1',
  name: 'John Doe',
  email: 'john@test.com',
  photoURL: 'https://example.com/photo.jpg',
  roles: ['customer'],
  active: true,
  passwordHash: 'hashed-current',
  lastLoginAt: null,
};

function mockReq(overrides = {}) {
  return {
    body: {},
    cookies: {},
    headers: {},
    query: {},
    user: null,
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  };
}

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.redirect = jest.fn().mockReturnValue(res);
  res.cookie = jest.fn().mockReturnValue(res);
  return res;
}

function mockNext() {
  return jest.fn();
}

function simulatePassport(cbParams) {
  passport.authenticate.mockImplementation((strategy, options, cb) => {
    return (_req, _res, next) => {
      cb(...cbParams);
    };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ================================
// LOGIN
// ================================
describe('login', () => {
  it('returns 400 when email missing', async () => {
    const req = mockReq({ body: { password: 'pass123' } });
    const res = mockRes();
    const next = mockNext();

    await controller.login(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400, message: 'Please provide email and password' }));
  });

  it('returns 400 when password missing', async () => {
    const req = mockReq({ body: { email: 'john@test.com' } });
    const res = mockRes();
    const next = mockNext();

    await controller.login(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('returns 401 when passport authentication fails', async () => {
    simulatePassport([null, null, { message: 'Invalid credentials' }]);
    const req = mockReq({ body: { email: 'john@test.com', password: 'wrong' } });
    const res = mockRes();
    const next = mockNext();

    await controller.login(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it('returns 401 when passport returns error object', async () => {
    simulatePassport([new Error('passport error')]);
    const req = mockReq({ body: { email: 'john@test.com', password: 'pass123' } });
    const res = mockRes();
    const next = mockNext();

    await controller.login(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'passport error' }));
  });

  it('returns 200 with tokens on success', async () => {
    simulatePassport([null, { ...mockUser }]);
    mockSignAccessToken.mockReturnValue('access-token');
    mockSignRefreshToken.mockReturnValue('refresh-token');
    prisma.user.update.mockResolvedValue(mockUser);

    const req = mockReq({ body: { email: 'john@test.com', password: 'correct' } });
    const res = mockRes();
    const next = mockNext();

    await controller.login(req, res, next);

    expect(storeRefreshToken).toHaveBeenCalledWith('user-1', 'refresh-token');
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'user-1' }, data: expect.objectContaining({ lastLoginAt: expect.any(Date) }) })
    );
    expect(enqueueEvent).toHaveBeenCalledWith(expect.objectContaining({ name: 'user.logged_in' }));
    expect(mockSetAuthCookies).toHaveBeenCalledWith(res, 'access-token', 'refresh-token');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: 'success',
      data: expect.objectContaining({
        user: expect.objectContaining({ id: 'user-1' }),
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      }),
    });
  });
});

// ================================
// REGISTER
// ================================
describe('register', () => {
  it('returns 400 when name missing', async () => {
    const req = mockReq({ body: { email: 'john@test.com', password: 'pass1234' } });
    const res = mockRes();
    const next = mockNext();

    await controller.register(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('returns 400 when email missing', async () => {
    const req = mockReq({ body: { name: 'John', password: 'pass1234' } });
    const res = mockRes();
    const next = mockNext();

    await controller.register(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('returns 400 when password missing', async () => {
    const req = mockReq({ body: { name: 'John', email: 'john@test.com' } });
    const res = mockRes();
    const next = mockNext();

    await controller.register(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('returns 400 when password is too short', async () => {
    const req = mockReq({ body: { name: 'John', email: 'john@test.com', password: '123' } });
    const res = mockRes();
    const next = mockNext();

    await controller.register(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400, message: 'Password must be at least 8 characters' }));
  });

  it('returns 409 when email already exists', async () => {
    prisma.user.findUnique.mockResolvedValue(mockUser);
    const req = mockReq({ body: { name: 'John', email: 'john@test.com', password: 'pass1234' } });
    const res = mockRes();
    const next = mockNext();

    await controller.register(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409 }));
  });

  it('returns 201 with tokens on success', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue(mockUser);
    mockSignAccessToken.mockReturnValue('access-token');
    mockSignRefreshToken.mockReturnValue('refresh-token');
    bcrypt.hash.mockResolvedValue('hashed-password');

    const req = mockReq({ body: { name: 'John Doe', email: 'JOHN@TEST.COM', password: 'pass1234' } });
    const res = mockRes();
    const next = mockNext();

    await controller.register(req, res, next);

    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'John Doe',
          email: 'john@test.com',
          authProvider: 'local',
          roles: ['customer'],
        }),
      })
    );
    expect(enqueueCreateStripeCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', email: 'john@test.com' })
    );
    expect(storeRefreshToken).toHaveBeenCalledWith('user-1', 'refresh-token');
    expect(enqueueEvent).toHaveBeenCalledWith(expect.objectContaining({ name: 'user.signed_up' }));
    expect(mockSetAuthCookies).toHaveBeenCalledWith(res, 'access-token', 'refresh-token');
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({
      status: 'success',
      data: expect.objectContaining({
        user: expect.objectContaining({ id: 'user-1' }),
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      }),
    });
  });
});

// ================================
// REFRESH
// ================================
describe('refresh', () => {
  it('returns 400 when no refresh token', async () => {
    const req = mockReq({ body: {}, cookies: {} });
    const res = mockRes();
    const next = mockNext();

    await controller.refresh(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('returns 401 when token is invalid', async () => {
    mockVerifyRefreshToken.mockImplementation(() => { throw new Error('jwt error'); });
    const req = mockReq({ body: { refreshToken: 'bad-token' } });
    const res = mockRes();
    const next = mockNext();

    await controller.refresh(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it('returns 401 when token is revoked', async () => {
    mockVerifyRefreshToken.mockReturnValue({ userId: 'user-1' });
    rotateRefreshToken.mockResolvedValue(false);
    const req = mockReq({ body: { refreshToken: 'revoked-token' } });
    const res = mockRes();
    const next = mockNext();

    await controller.refresh(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401, message: 'Refresh token has been revoked. Please log in again.' }));
  });

  it('returns 401 when user not found', async () => {
    mockVerifyRefreshToken.mockReturnValue({ userId: 'unknown' });
    rotateRefreshToken.mockResolvedValue(true);
    prisma.user.findUnique.mockResolvedValue(null);
    const req = mockReq({ body: { refreshToken: 'valid-token' } });
    const res = mockRes();
    const next = mockNext();

    await controller.refresh(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it('returns 401 when user is inactive', async () => {
    mockVerifyRefreshToken.mockReturnValue({ userId: 'user-1' });
    rotateRefreshToken.mockResolvedValue(true);
    prisma.user.findUnique.mockResolvedValue({ ...mockUser, active: false });
    const req = mockReq({ body: { refreshToken: 'valid-token' } });
    const res = mockRes();
    const next = mockNext();

    await controller.refresh(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it('returns 200 with new tokens on success', async () => {
    mockVerifyRefreshToken.mockReturnValue({ userId: 'user-1' });
    rotateRefreshToken.mockResolvedValue(true);
    prisma.user.findUnique.mockResolvedValue(mockUser);
    mockSignAccessToken.mockReturnValue('new-access-token');
    mockSignRefreshToken.mockReturnValue('new-refresh-token');

    const req = mockReq({ cookies: { refreshToken: 'valid-token' } });
    const res = mockRes();
    const next = mockNext();

    await controller.refresh(req, res, next);

    expect(rotateRefreshToken).toHaveBeenCalledWith('user-1', 'valid-token', 'new-refresh-token');
    expect(mockSetAuthCookies).toHaveBeenCalledWith(res, 'new-access-token', 'new-refresh-token');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: 'success',
      data: { accessToken: 'new-access-token', refreshToken: 'new-refresh-token' },
    });
  });
});

// ================================
// SET COOKIES
// ================================
describe('setCookies', () => {
  it('returns 400 when accessToken missing', async () => {
    const req = mockReq({ body: { refreshToken: 'rt' } });
    const res = mockRes();
    const next = mockNext();

    await controller.setCookies(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('returns 400 when refreshToken missing', async () => {
    const req = mockReq({ body: { accessToken: 'at' } });
    const res = mockRes();
    const next = mockNext();

    await controller.setCookies(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('returns 401 when accessToken is invalid', async () => {
    mockVerifyAccessToken.mockImplementation(() => { throw new Error('jwt error'); });
    const req = mockReq({ body: { accessToken: 'bad-at', refreshToken: 'rt' } });
    const res = mockRes();
    const next = mockNext();

    await controller.setCookies(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it('returns 200 on success', async () => {
    mockVerifyAccessToken.mockReturnValue({ userId: 'user-1' });
    const req = mockReq({ body: { accessToken: 'valid-at', refreshToken: 'valid-rt' } });
    const res = mockRes();
    const next = mockNext();

    await controller.setCookies(req, res, next);

    expect(mockVerifyAccessToken).toHaveBeenCalledWith('valid-at');
    expect(mockSetAuthCookies).toHaveBeenCalledWith(res, 'valid-at', 'valid-rt');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ status: 'success', message: 'Cookies set' });
  });
});

// ================================
// LOGOUT
// ================================
describe('logout', () => {
  it('clears refresh token when user is authenticated', async () => {
    const req = mockReq({ user: { id: 'user-1' } });
    const res = mockRes();

    await controller.logout(req, res);

    expect(clearRefreshToken).toHaveBeenCalledWith('user-1');
    expect(mockClearAuthCookies).toHaveBeenCalledWith(res);
    expect(enqueueEvent).toHaveBeenCalledWith(expect.objectContaining({ name: 'user.logged_out' }));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
  });

  it('works when no user in request', async () => {
    const req = mockReq();
    const res = mockRes();

    await controller.logout(req, res);

    expect(clearRefreshToken).not.toHaveBeenCalled();
    expect(mockClearAuthCookies).toHaveBeenCalledWith(res);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

// ================================
// FORGOT PASSWORD
// ================================
describe('forgotPassword', () => {
  it('returns 400 when email missing', async () => {
    const req = mockReq({ body: {} });
    const res = mockRes();
    const next = mockNext();

    await controller.forgotPassword(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('returns 200 when email not found (no enumeration)', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const req = mockReq({ body: { email: 'nonexistent@test.com' } });
    const res = mockRes();
    const next = mockNext();

    await controller.forgotPassword(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
  });

  it('sends email and returns 200 on success', async () => {
    const { sendEmail } = require('../../utils/emailService');
    sendEmail.mockResolvedValue();

    prisma.user.findUnique.mockResolvedValue(mockUser);
    mockSignPasswordResetToken.mockReturnValue('reset-token');

    const req = mockReq({ body: { email: 'john@test.com' } });
    const res = mockRes();
    const next = mockNext();

    await controller.forgotPassword(req, res, next);

    expect(mockSignPasswordResetToken).toHaveBeenCalledWith({ userId: 'user-1' });
    expect(sendEmail).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
  });

  it('returns 200 when email send fails', async () => {
    const { sendEmail } = require('../../utils/emailService');
    sendEmail.mockRejectedValue(new Error('email error'));

    prisma.user.findUnique.mockResolvedValue(mockUser);
    mockSignPasswordResetToken.mockReturnValue('reset-token');

    const req = mockReq({ body: { email: 'john@test.com' } });
    const res = mockRes();
    const next = mockNext();

    await controller.forgotPassword(req, res, next);

    expect(sendEmail).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
  });
});

// ================================
// RESET PASSWORD
// ================================
describe('resetPassword', () => {
  it('returns 400 when token missing', async () => {
    const req = mockReq({ body: { password: 'newpass123' } });
    const res = mockRes();
    const next = mockNext();

    await controller.resetPassword(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('returns 400 when password missing', async () => {
    const req = mockReq({ body: { token: 'some-token' } });
    const res = mockRes();
    const next = mockNext();

    await controller.resetPassword(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('returns 400 when password too short', async () => {
    const req = mockReq({ body: { token: 'some-token', password: '123' } });
    const res = mockRes();
    const next = mockNext();

    await controller.resetPassword(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400, message: 'Password must be at least 8 characters' }));
  });

  it('returns 400 when token is invalid', async () => {
    mockVerifyPasswordResetToken.mockImplementation(() => { throw new Error('jwt error'); });
    const req = mockReq({ body: { token: 'bad-token', password: 'newpass123' } });
    const res = mockRes();
    const next = mockNext();

    await controller.resetPassword(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('returns 200 on success', async () => {
    mockVerifyPasswordResetToken.mockReturnValue({ userId: 'user-1' });
    bcrypt.hash.mockResolvedValue('new-hashed');
    prisma.user.update.mockResolvedValue(mockUser);

    const req = mockReq({ body: { token: 'valid-token', password: 'newpass123' } });
    const res = mockRes();
    const next = mockNext();

    await controller.resetPassword(req, res, next);

    expect(bcrypt.hash).toHaveBeenCalledWith('newpass123', 10);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'user-1' }, data: expect.objectContaining({ passwordHash: 'new-hashed' }) })
    );
    expect(enqueueEvent).toHaveBeenCalledWith(expect.objectContaining({ name: 'user.password_reset' }));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
  });
});

// ================================
// CHANGE PASSWORD
// ================================
describe('changePassword', () => {
  it('returns 400 when currentPassword missing', async () => {
    const req = mockReq({ user: { id: 'user-1' }, body: { newPassword: 'newpass123' } });
    const res = mockRes();
    const next = mockNext();

    await controller.changePassword(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('returns 400 when newPassword missing', async () => {
    const req = mockReq({ user: { id: 'user-1' }, body: { currentPassword: 'old' } });
    const res = mockRes();
    const next = mockNext();

    await controller.changePassword(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('returns 400 when newPassword too short', async () => {
    const req = mockReq({ user: { id: 'user-1' }, body: { currentPassword: 'old', newPassword: '123' } });
    const res = mockRes();
    const next = mockNext();

    await controller.changePassword(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400, message: 'Password must be at least 8 characters' }));
  });

  it('returns 400 when user has no passwordHash', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', passwordHash: null });
    const req = mockReq({ user: { id: 'user-1' }, body: { currentPassword: 'old', newPassword: 'newpass123' } });
    const res = mockRes();
    const next = mockNext();

    await controller.changePassword(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('returns 401 when current password is wrong', async () => {
    prisma.user.findUnique.mockResolvedValue(mockUser);
    bcrypt.compare.mockResolvedValue(false);
    const req = mockReq({ user: { id: 'user-1' }, body: { currentPassword: 'wrong', newPassword: 'newpass123' } });
    const res = mockRes();
    const next = mockNext();

    await controller.changePassword(req, res, next);

    expect(bcrypt.compare).toHaveBeenCalledWith('wrong', 'hashed-current');
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it('returns 200 on success', async () => {
    prisma.user.findUnique.mockResolvedValue(mockUser);
    bcrypt.compare.mockResolvedValue(true);
    bcrypt.hash.mockResolvedValue('new-hashed');
    prisma.user.update.mockResolvedValue(mockUser);

    const req = mockReq({ user: { id: 'user-1' }, body: { currentPassword: 'correct', newPassword: 'newpass123' } });
    const res = mockRes();
    const next = mockNext();

    await controller.changePassword(req, res, next);

    expect(bcrypt.compare).toHaveBeenCalledWith('correct', 'hashed-current');
    expect(bcrypt.hash).toHaveBeenCalledWith('newpass123', 10);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'user-1' }, data: expect.objectContaining({ passwordHash: 'new-hashed' }) })
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'success', message: 'Password updated successfully' }));
  });
});

// ================================
// GOOGLE AUTH
// ================================
describe('googleAuth', () => {
  const origGoogleId = process.env.GOOGLE_CLIENT_ID;
  const origGoogleSecret = process.env.GOOGLE_CLIENT_SECRET;

  afterEach(() => {
    process.env.GOOGLE_CLIENT_ID = origGoogleId;
    process.env.GOOGLE_CLIENT_SECRET = origGoogleSecret;
  });

  it('redirects to Google when configured', () => {
    process.env.GOOGLE_CLIENT_ID = 'google-id';
    process.env.GOOGLE_CLIENT_SECRET = 'google-secret';
    passport.authenticate.mockReturnValue(jest.fn());

    const req = mockReq();
    const res = mockRes();
    const next = mockNext();

    controller.googleAuth(req, res, next);

    expect(passport.authenticate).toHaveBeenCalledWith('google', expect.objectContaining({ scope: ['profile', 'email'] }));
  });

  it('redirects to login with error when Google not configured', () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;

    const req = mockReq({ headers: { origin: 'http://localhost:3000' } });
    const res = mockRes();

    controller.googleAuth(req, res);

    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('login?error=Google'));
  });
});

// ================================
// GOOGLE CALLBACK
// ================================
describe('googleCallback', () => {
  it('returns 401 when passport authentication fails', async () => {
    passport.authenticate.mockImplementation((strategy, options, cb) => {
      return (_req, _res, next) => {
        cb(new Error('google error'));
      };
    });
    const req = mockReq();
    const res = mockRes();
    const next = mockNext();

    await controller.googleCallback(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'google error' }));
  });

  it('returns 401 when no user returned', async () => {
    passport.authenticate.mockImplementation((strategy, options, cb) => {
      return (_req, _res, next) => {
        cb(null, null, { message: 'Google authentication failed' });
      };
    });
    const req = mockReq();
    const res = mockRes();
    const next = mockNext();

    await controller.googleCallback(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it('redirects with tokens on success', (done) => {
    passport.authenticate.mockImplementation((strategy, options, cb) => {
      return (_req, _res, next) => {
        cb(null, { ...mockUser });
      };
    });
    mockSignAccessToken.mockReturnValue('google-access-token');
    mockSignRefreshToken.mockReturnValue('google-refresh-token');
    prisma.user.update.mockResolvedValue(mockUser);

    const req = mockReq({ query: { state: 'http://localhost:3000' } });
    const res = mockRes();
    const next = mockNext();

    controller.googleCallback(req, res, next);

    setImmediate(() => {
      expect(storeRefreshToken).toHaveBeenCalledWith('user-1', 'google-refresh-token');
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'user-1' }, data: expect.objectContaining({ lastLoginAt: expect.any(Date) }) })
      );
      expect(enqueueEvent).toHaveBeenCalledWith(expect.objectContaining({ name: 'user.logged_in', properties: { method: 'google' } }));
      expect(mockSetAuthCookies).toHaveBeenCalledWith(res, 'google-access-token', 'google-refresh-token');
      expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('google-access-token'));
      done();
    });
  });
});
