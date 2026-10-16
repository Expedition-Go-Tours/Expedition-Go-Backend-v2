/**
 * Shared transactional-email preview service (src/core/services/emailPreviews).
 *
 * It backs both the dev preview scripts and the token-gated admin gallery
 * endpoint, so the load-bearing parts are: the signed-token round trip (mint,
 * verify, reject tampered/expired, refuse to mint without a secret), template
 * discovery from the committed artifacts, and that the sample data is mock
 * content with no real PII.
 */
const fs = require('fs');

const previews = require('../../src/core/services/emailPreviews');

const ORIGINAL = {
  secret: process.env.EMAIL_PREVIEW_TOKEN_SECRET,
  jwt: process.env.JWT_SECRET,
  ttl: process.env.EMAIL_PREVIEW_TTL_MS,
};

afterEach(() => {
  if (ORIGINAL.secret === undefined) delete process.env.EMAIL_PREVIEW_TOKEN_SECRET;
  else process.env.EMAIL_PREVIEW_TOKEN_SECRET = ORIGINAL.secret;
  if (ORIGINAL.jwt === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = ORIGINAL.jwt;
  if (ORIGINAL.ttl === undefined) delete process.env.EMAIL_PREVIEW_TTL_MS;
  else process.env.EMAIL_PREVIEW_TTL_MS = ORIGINAL.ttl;
});

describe('signed preview tokens', () => {
  it('refuses to mint without a configured secret', () => {
    delete process.env.EMAIL_PREVIEW_TOKEN_SECRET;
    delete process.env.JWT_SECRET;
    expect(previews.signPreviewToken()).toBeNull();
    expect(previews.verifyPreviewToken('123.abc')).toBeNull();
  });

  it('round-trips a freshly minted token', () => {
    process.env.EMAIL_PREVIEW_TOKEN_SECRET = 'unit-secret';
    const token = previews.signPreviewToken(60_000);
    expect(typeof token).toBe('string');
    const verified = previews.verifyPreviewToken(token);
    expect(verified).not.toBeNull();
    expect(verified.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('falls back to JWT_SECRET when no dedicated secret is set', () => {
    delete process.env.EMAIL_PREVIEW_TOKEN_SECRET;
    process.env.JWT_SECRET = 'jwt-secret';
    const token = previews.signPreviewToken(60_000);
    expect(previews.verifyPreviewToken(token)).not.toBeNull();
  });

  it('rejects an expired token', () => {
    process.env.EMAIL_PREVIEW_TOKEN_SECRET = 'unit-secret';
    const token = previews.signPreviewToken(-1000);
    expect(previews.verifyPreviewToken(token)).toBeNull();
  });

  it('rejects a tampered signature', () => {
    process.env.EMAIL_PREVIEW_TOKEN_SECRET = 'unit-secret';
    const token = previews.signPreviewToken(60_000);
    const [exp, sig] = token.split('.');
    const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
    expect(previews.verifyPreviewToken(`${exp}.${flipped}`)).toBeNull();
    // A valid token signed with a different secret must not verify.
    process.env.EMAIL_PREVIEW_TOKEN_SECRET = 'other-secret';
    expect(previews.verifyPreviewToken(token)).toBeNull();
  });

  it('honours EMAIL_PREVIEW_TTL_MS', () => {
    process.env.EMAIL_PREVIEW_TOKEN_SECRET = 'unit-secret';
    process.env.EMAIL_PREVIEW_TTL_MS = '5000';
    expect(previews.previewTtlMs()).toBe(5000);
  });
});

describe('template discovery + rendering', () => {
  it('lists every committed generated artifact', () => {
    const keys = previews.listTemplateKeys();
    const files = fs
      .readdirSync(previews.GENERATED_DIR)
      .filter((f) => f.endsWith('.html'))
      .map((f) => f.replace(/\.html$/, ''));
    expect(keys.sort()).toEqual(files.sort());
    expect(keys).toContain('supplier-review-invite');
    expect(keys).toContain('booking-confirmed');
  });

  it('renders a template with no unresolved Handlebars', () => {
    const html = previews.renderTemplateDoc('booking-confirmed');
    expect(html).toMatch(/<!doctype html>/i);
    expect(html).not.toContain('{{');
  });

  it('throws for an unknown key and exposes the known keys', () => {
    expect(() => previews.renderTemplateDoc('not-a-template')).toThrow(/Unknown template key/);
    try {
      previews.renderTemplateDoc('not-a-template');
    } catch (err) {
      expect(err.knownKeys).toContain('booking-confirmed');
    }
  });
});

describe('sample data + gallery', () => {
  it('uses anonymised mock PII, never a real address', () => {
    expect(previews.SAMPLE.customerEmail).toBe('ada@example.com');
    expect(previews.SAMPLE.customerAvatarUrl).toBe('');
    expect(JSON.stringify(previews.SAMPLE)).not.toContain('@gmail.com');
  });

  it('builds a gallery that frames each requested template', () => {
    const keys = ['booking-confirmed', 'supplier-review-invite'];
    const html = previews.buildGallery(keys, {
      srcFor: (k) => `/x/${k}`,
      linkFor: () => null,
      changed: new Set(['supplier-review-invite']),
    });
    expect(html).toContain('<!doctype html');
    expect(html).toContain('src="/x/booking-confirmed"');
    expect(html).toContain('src="/x/supplier-review-invite"');
    expect(html).toContain('updated');
    expect(html).toContain('Booking Confirmed');
  });

  it('groups templates by their key prefix', () => {
    expect(previews.groupFor('booking-confirmed')).toBe('Customer');
    expect(previews.groupFor('supplier-new-booking')).toBe('Supplier');
    expect(previews.groupFor('admin-cancellation-request')).toBe('Admin');
    expect(previews.titleize('supplier-review-invite')).toBe('Supplier Review Invite');
  });
});
