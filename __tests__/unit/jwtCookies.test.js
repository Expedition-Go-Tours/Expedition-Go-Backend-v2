const ORIGINAL_ENV = { ...process.env };

function loadJwt(overrides = {}) {
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  let jwt;
  jest.isolateModules(() => {
    jwt = require('../../config/jwt');
  });
  return jwt;
}

function mockRes(hostname) {
  const res = {
    req: { hostname },
    cookie: jest.fn(),
    clearCookie: jest.fn(),
  };
  return res;
}

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
}

describe('auth cookie scope', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'test-access-secret';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
    delete process.env.AUTH_COOKIE_DOMAIN;
  });

  afterEach(() => {
    restoreEnv();
    jest.resetModules();
  });

  it('leaves cookies host-only on the Ghana API', () => {
    const { setAuthCookies } = loadJwt();
    const res = mockRes('api.travioghana.com');

    setAuthCookies(res, 'access', 'refresh');

    expect(res.cookie).toHaveBeenCalledWith(
      'accessToken',
      'access',
      expect.objectContaining({ domain: undefined, path: '/', secure: true, sameSite: 'none' })
    );
    expect(res.cookie).toHaveBeenCalledWith(
      'refreshToken',
      'refresh',
      expect.objectContaining({ domain: undefined, path: '/api/auth', secure: true, sameSite: 'none' })
    );
    expect(res.clearCookie).not.toHaveBeenCalled();
  });

  it('leaves cookies host-only on the Expedition API', () => {
    const { setAuthCookies } = loadJwt();
    const res = mockRes('api.expeditiongotours.com');

    setAuthCookies(res, 'access', 'refresh');

    expect(res.cookie).toHaveBeenCalledWith(
      'accessToken',
      'access',
      expect.objectContaining({ domain: undefined })
    );
    expect(res.clearCookie).not.toHaveBeenCalled();
  });

  it('clears the legacy Africa parent-domain cookie once on Africa hosts', () => {
    const { setAuthCookies } = loadJwt();
    const res = mockRes('apiv1.travioafrica.com');

    setAuthCookies(res, 'access', 'refresh');

    expect(res.cookie).toHaveBeenCalledWith(
      'accessToken',
      'access',
      expect.objectContaining({ domain: undefined })
    );
    expect(res.clearCookie).toHaveBeenCalledWith(
      'accessToken',
      expect.objectContaining({ domain: '.travioafrica.com', path: '/' })
    );
    expect(res.clearCookie).toHaveBeenCalledWith(
      'refreshToken',
      expect.objectContaining({ domain: '.travioafrica.com', path: '/api/auth' })
    );
  });

  it('honours an explicit AUTH_COOKIE_DOMAIN override', () => {
    const { setAuthCookies } = loadJwt({ AUTH_COOKIE_DOMAIN: '.travioghana.com' });
    const res = mockRes('api.travioghana.com');

    setAuthCookies(res, 'access', 'refresh');

    expect(res.cookie).toHaveBeenCalledWith(
      'accessToken',
      'access',
      expect.objectContaining({ domain: '.travioghana.com' })
    );
    expect(res.clearCookie).not.toHaveBeenCalled();
  });

  it('clears host-only cookies on logout', () => {
    const { clearAuthCookies } = loadJwt();
    const res = mockRes('api.travioghana.com');

    clearAuthCookies(res);

    expect(res.cookie).toHaveBeenCalledWith(
      'accessToken',
      '',
      expect.objectContaining({ domain: undefined, maxAge: 0 })
    );
    expect(res.cookie).toHaveBeenCalledWith(
      'refreshToken',
      '',
      expect.objectContaining({ domain: undefined, maxAge: 0 })
    );
  });
});
