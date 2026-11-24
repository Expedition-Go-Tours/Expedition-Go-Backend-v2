const crypto = require('crypto');
const {
  mintReviewProof,
  verifyReviewProof,
  emailHash,
  normalizeDateOnly,
} = require('../../src/core/services/restaurantReviewProof');

function payloadOf(token) {
  return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
}

function reSign(payload) {
  const part = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto
    .createHmac('sha256', 'test-review-secret')
    .update(part)
    .digest('base64url');
  return `${part}.${signature}`;
}

describe('restaurantReviewProof', () => {
  const originalSecret = process.env.RESTAURANT_REVIEW_TOKEN_SECRET;

  beforeAll(() => {
    process.env.RESTAURANT_REVIEW_TOKEN_SECRET = 'test-review-secret';
  });

  afterAll(() => {
    if (originalSecret === undefined) delete process.env.RESTAURANT_REVIEW_TOKEN_SECRET;
    else process.env.RESTAURANT_REVIEW_TOKEN_SECRET = originalSecret;
  });

  it('mints a token whose claims survive verification', () => {
    const minted = mintReviewProof({
      venueId: 'v1',
      proofMethod: 'QR_RECEIPT',
      visitDate: '2026-11-20',
      expiresInDays: 7,
    });

    expect(minted.proofRef).toMatch(/^[0-9a-f-]{36}$/);
    expect(minted.visitDate).toBe('2026-11-20');
    expect(
      verifyReviewProof(minted.token, { venueId: 'v1', email: 'nobody@example.com' }),
    ).toMatchObject({
      proofRef: minted.proofRef,
      proofMethod: 'QR_RECEIPT',
      visitDate: '2026-11-20',
    });
  });

  it('binds an emailed invite to a hash of the address, case-insensitively', () => {
    const minted = mintReviewProof({
      venueId: 'v1',
      proofMethod: 'EMAIL_INVITE',
      email: 'Guest@Example.com',
    });

    expect(payloadOf(minted.token).h).toBe(emailHash('guest@example.com'));
    expect(() =>
      verifyReviewProof(minted.token, { venueId: 'v1', email: 'GUEST@example.com' }),
    ).not.toThrow();
    expect(() =>
      verifyReviewProof(minted.token, { venueId: 'v1', email: 'other@example.com' }),
    ).toThrow(expect.objectContaining({ errorCode: 'PROOF_FOR_SOMEONE_ELSE' }));
  });

  it('refuses a token that was altered after signing', () => {
    const minted = mintReviewProof({ venueId: 'v1', proofMethod: 'QR_RECEIPT' });
    const payload = payloadOf(minted.token);
    payload.v = 'v2';
    const tampered = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${minted.token.split('.')[1]}`;

    expect(() => verifyReviewProof(tampered, { venueId: 'v2' })).toThrow(
      expect.objectContaining({ errorCode: 'INVALID_PROOF', statusCode: 403 }),
    );
  });

  it('refuses a token minted for another venue', () => {
    const minted = mintReviewProof({ venueId: 'v1', proofMethod: 'QR_RECEIPT' });

    expect(() => verifyReviewProof(minted.token, { venueId: 'v2' })).toThrow(
      expect.objectContaining({ errorCode: 'PROOF_VENUE_MISMATCH' }),
    );
  });

  it('refuses an expired token even when the signature is good', () => {
    const minted = mintReviewProof({ venueId: 'v1', proofMethod: 'QR_RECEIPT' });
    const expired = reSign({ ...payloadOf(minted.token), e: Date.now() - 1000 });

    expect(() => verifyReviewProof(expired, { venueId: 'v1' })).toThrow(
      expect.objectContaining({ errorCode: 'PROOF_EXPIRED', statusCode: 403 }),
    );
  });

  it('rejects impossible visit dates before they reach a review row', () => {
    expect(() => normalizeDateOnly('2026-02-30')).toThrow(
      expect.objectContaining({ errorCode: 'INVALID_VISIT_DATE' }),
    );
    expect(() =>
      mintReviewProof({ venueId: 'v1', proofMethod: 'QR_RECEIPT', visitDate: '20/11/2026' }),
    ).toThrow(expect.objectContaining({ errorCode: 'INVALID_VISIT_DATE' }));
  });

  it('never accepts an unknown proof method', () => {
    expect(() => mintReviewProof({ venueId: 'v1', proofMethod: 'INSTAGRAM' })).toThrow(
      expect.objectContaining({ errorCode: 'INVALID_PROOF_METHOD' }),
    );
  });
});
