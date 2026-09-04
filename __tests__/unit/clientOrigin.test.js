const {
  normalizeOrigin,
  getAllowedClientOrigins,
  resolveAllowedClientUrl,
} = require('../../utils/clientOrigin');

describe('clientOrigin', () => {
  afterEach(() => {
    delete process.env.CLIENT_URL;
    delete process.env.ALLOWED_ORIGINS;
  });

  it('normalizes an origin and strips any path', () => {
    expect(normalizeOrigin('https://expeditiongotours.vercel.app/booking/x')).toBe('https://expeditiongotours.vercel.app');
    expect(normalizeOrigin('https://travioafrica.com')).toBe('https://travioafrica.com');
    expect(normalizeOrigin('not a url')).toBeNull();
    expect(normalizeOrigin('')).toBeNull();
    expect(normalizeOrigin(undefined)).toBeNull();
  });

  it('collects CLIENT_URL + ALLOWED_ORIGINS into the allow set', () => {
    process.env.CLIENT_URL = 'https://travioafrica.com';
    process.env.ALLOWED_ORIGINS = 'https://expeditiongotours.vercel.app,https://travioafrica.com/path, http://localhost:5173';
    const set = getAllowedClientOrigins();
    expect(set.has('https://expeditiongotours.vercel.app')).toBe(true);
    expect(set.has('https://travioafrica.com')).toBe(true);
    expect(set.has('http://localhost:5173')).toBe(true);
  });

  it('returns the request origin when allow-listed', () => {
    process.env.CLIENT_URL = 'https://travioafrica.com';
    process.env.ALLOWED_ORIGINS = 'https://expeditiongotours.vercel.app';
    const req = { headers: { origin: 'https://expeditiongotours.vercel.app' } };
    expect(resolveAllowedClientUrl(req)).toBe('https://expeditiongotours.vercel.app');
  });

  it('falls back to CLIENT_URL for an untrusted origin and warns', () => {
    process.env.CLIENT_URL = 'https://travioafrica.com';
    process.env.ALLOWED_ORIGINS = 'https://expeditiongotours.vercel.app';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const req = { headers: { origin: 'https://evil.example' } };
      expect(resolveAllowedClientUrl(req)).toBe('https://travioafrica.com');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('uses the referer origin when the Origin header is absent', () => {
    process.env.CLIENT_URL = 'https://travioafrica.com';
    process.env.ALLOWED_ORIGINS = 'https://expeditiongotours.vercel.app';
    const req = { headers: { referer: 'https://expeditiongotours.vercel.app/tour/abc' } };
    expect(resolveAllowedClientUrl(req)).toBe('https://expeditiongotours.vercel.app');
  });

  it('falls back to CLIENT_URL when the request has no origin headers', () => {
    process.env.CLIENT_URL = 'https://travioafrica.com';
    expect(resolveAllowedClientUrl({ headers: {} })).toBe('https://travioafrica.com');
    expect(resolveAllowedClientUrl(undefined)).toBe('https://travioafrica.com');
  });
});
