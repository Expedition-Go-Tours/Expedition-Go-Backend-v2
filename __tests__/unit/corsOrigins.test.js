const {
  DEV_ORIGINS,
  STAGING_ORIGIN,
  httpOrigins,
  socketOrigins,
  isAllowedOrigin,
  isTrustedPreviewOrigin,
} = require('../../config/corsOrigins');

// The module reads ALLOWED_ORIGINS on every call, so each test sets it
// explicitly. Restore afterwards: Jest shares the process environment across
// test files, and a leaked value would make another file's assertions about
// the default allow-list fail.
const ORIGINAL_ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS;

afterEach(() => {
  if (ORIGINAL_ALLOWED_ORIGINS === undefined) {
    delete process.env.ALLOWED_ORIGINS;
  } else {
    process.env.ALLOWED_ORIGINS = ORIGINAL_ALLOWED_ORIGINS;
  }
});

const PRODUCTION = 'https://supplier.travioghana.com';

describe('explicit allow-list', () => {
  it('allows a request carrying no Origin', () => {
    // Same-origin and non-browser callers send none, and have no cross-origin
    // capability to restrict.
    expect(isAllowedOrigin(undefined, [])).toBe(true);
    expect(isAllowedOrigin('', [PRODUCTION])).toBe(true);
  });

  it('allows an origin listed in ALLOWED_ORIGINS', () => {
    process.env.ALLOWED_ORIGINS = PRODUCTION;
    expect(isAllowedOrigin(PRODUCTION, httpOrigins())).toBe(true);
  });

  it('rejects an origin that is not listed', () => {
    process.env.ALLOWED_ORIGINS = PRODUCTION;
    expect(isAllowedOrigin('https://evil.example', httpOrigins())).toBe(false);
  });

  it('does not trust the production dashboard domain implicitly', () => {
    // It is authorised because ops lists it, not because of what it is called.
    process.env.ALLOWED_ORIGINS = 'https://some-other-host.example';
    expect(isAllowedOrigin(PRODUCTION, httpOrigins())).toBe(false);
  });
});

describe('httpOrigins (Express)', () => {
  it('replaces the dev defaults when ALLOWED_ORIGINS is set', () => {
    process.env.ALLOWED_ORIGINS = PRODUCTION;
    expect(httpOrigins()).toEqual([PRODUCTION]);
  });

  it('falls back to the dev defaults when ALLOWED_ORIGINS is unset', () => {
    delete process.env.ALLOWED_ORIGINS;
    expect(httpOrigins()).toEqual(DEV_ORIGINS);
  });

  it('trims whitespace and drops empty entries', () => {
    process.env.ALLOWED_ORIGINS = ` ${PRODUCTION} ,, http://localhost:5173 `;
    expect(httpOrigins()).toEqual([PRODUCTION, 'http://localhost:5173']);
  });
});

describe('socketOrigins (Socket.IO)', () => {
  it('keeps the dev defaults alongside ALLOWED_ORIGINS', () => {
    // The websocket surface has always authorised localhost in addition to the
    // configured list; it must not narrow as a side effect of this refactor.
    process.env.ALLOWED_ORIGINS = PRODUCTION;
    expect(socketOrigins()).toEqual([PRODUCTION, ...DEV_ORIGINS]);
  });

  it('does not list an origin twice', () => {
    process.env.ALLOWED_ORIGINS = `http://localhost:5173,${PRODUCTION}`;
    const origins = socketOrigins();
    expect(origins.filter((o) => o === 'http://localhost:5173')).toHaveLength(1);
    // 4 dev origins + the one configured origin that is not a dev origin.
    expect(origins).toHaveLength(DEV_ORIGINS.length + 1);
  });

  it('falls back to the dev defaults when ALLOWED_ORIGINS is unset', () => {
    delete process.env.ALLOWED_ORIGINS;
    expect(socketOrigins()).toEqual(DEV_ORIGINS);
  });
});

describe('fixed staging host', () => {
  it('is authorised regardless of ALLOWED_ORIGINS', () => {
    delete process.env.ALLOWED_ORIGINS;
    expect(isAllowedOrigin(STAGING_ORIGIN, httpOrigins())).toBe(true);

    process.env.ALLOWED_ORIGINS = PRODUCTION;
    expect(isAllowedOrigin(STAGING_ORIGIN, httpOrigins())).toBe(true);
  });

  it('matches exactly — no subdomain or sibling host rides along', () => {
    expect(isTrustedPreviewOrigin('https://supplier-staging.travioghana.com.evil.example')).toBe(false);
    expect(isTrustedPreviewOrigin('https://staging.travioghana.com')).toBe(false);
    expect(isTrustedPreviewOrigin('http://supplier-staging.travioghana.com')).toBe(false);
  });
});

describe('per-branch Vercel previews', () => {
  it('allows this project’s preview URLs', () => {
    delete process.env.ALLOWED_ORIGINS;
    const previews = [
      'https://travio-ghana-supplier-git-staging-a1b2c3d4.vercel.app',
      'https://travio-ghana-supplier-git-fix-booking-filters-e5f6a7b8.vercel.app',
      'https://travio-ghana-supplier-git-feat-supplier-notification-recipients-1a2b3c4d.vercel.app',
      'https://Travio-Ghana-Supplier-Git-Staging-a1b2c3d4.vercel.app',
    ];
    for (const origin of previews) {
      expect(isAllowedOrigin(origin, httpOrigins())).toBe(true);
    }
  });

  it('rejects another project’s preview URL', () => {
    process.env.ALLOWED_ORIGINS = PRODUCTION;
    expect(isAllowedOrigin('https://some-other-app-git-main-abc123.vercel.app', httpOrigins())).toBe(false);
    // The platform domain alone authorises nothing.
    expect(isAllowedOrigin('https://vercel.app', httpOrigins())).toBe(false);
  });

  it('rejects look-alike hosts that only imitate the prefix or the suffix', () => {
    process.env.ALLOWED_ORIGINS = PRODUCTION;
    expect(isAllowedOrigin('https://travio-ghana-supplier-git-staging-a1b2c3d4.evil.example', httpOrigins())).toBe(false);
    expect(isAllowedOrigin('https://travio-ghana-supplier-git-staging-a1b2c3d4.vercel.app.evil.example', httpOrigins())).toBe(false);
    expect(isAllowedOrigin('https://travio-ghana-supplier-git-.vercel.app', httpOrigins())).toBe(false);
  });

  it('rejects anything that is not https', () => {
    process.env.ALLOWED_ORIGINS = PRODUCTION;
    expect(isAllowedOrigin('http://travio-ghana-supplier-git-staging-a1b2c3d4.vercel.app', httpOrigins())).toBe(false);
    expect(isAllowedOrigin('file://travio-ghana-supplier-git-staging-a1b2c3d4.vercel.app', httpOrigins())).toBe(false);
  });

  it('rejects a value that is not a URL at all', () => {
    process.env.ALLOWED_ORIGINS = PRODUCTION;
    expect(isAllowedOrigin('not a url', httpOrigins())).toBe(false);
    expect(isAllowedOrigin('travio-ghana-supplier-git-staging.vercel.app', httpOrigins())).toBe(false);
  });

  it('rejects an origin carrying a path, query or fragment', () => {
    // Browsers never send these in an Origin, so one that does is not browser
    // traffic and must not be trusted as though it were.
    process.env.ALLOWED_ORIGINS = PRODUCTION;
    expect(isAllowedOrigin('https://travio-ghana-supplier-git-staging-a1b2c3d4.vercel.app/admin', httpOrigins())).toBe(false);
    expect(isAllowedOrigin('https://travio-ghana-supplier-git-staging-a1b2c3d4.vercel.app/?x=1', httpOrigins())).toBe(false);
    expect(isAllowedOrigin('https://travio-ghana-supplier-git-staging-a1b2c3d4.vercel.app/#x', httpOrigins())).toBe(false);
  });
});
