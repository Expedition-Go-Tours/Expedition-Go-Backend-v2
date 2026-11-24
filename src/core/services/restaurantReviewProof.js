/**
 * Signed, single-use proof of a restaurant visit.
 *
 * The review write path uses this to decide provenance. A client never sends
 * `source` or `verified`: it hands back a token the backend minted, and the
 * token carries the venue, the proof method, an expiry and (when mailed) a hash
 * of the invited address. Redemption is recorded in `RestaurantVenueReview.proofRef`,
 * which is unique, so the same token cannot vouch for two reviews.
 *
 * Tokens are short-lived and stateless on purpose. A QR invite can be handed
 * out before there is an owner portal or a claims flow, and there is no new
 * table to migrate when those arrive.
 */

const crypto = require('crypto');
const AppError = require('./appError');

const CLAIM_KIND = 'rvp';
const METHODS = ['QR_RECEIPT', 'EMAIL_INVITE'];
const DEFAULT_TTL_DAYS = 30;
const MAX_TTL_DAYS = 90;

function signingSecret() {
  return (
    process.env.RESTAURANT_REVIEW_TOKEN_SECRET ||
    process.env.JWT_SECRET ||
    'insecure-dev-review-proof'
  );
}

function encode(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decode(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function signatureFor(payloadPart) {
  return crypto.createHmac('sha256', signingSecret()).update(payloadPart).digest('base64url');
}

/** Constant-time comparison. A plain `===` on signatures leaks byte position. */
function sameSignature(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function emailHash(email) {
  if (!email) return null;
  return crypto
    .createHmac('sha256', signingSecret())
    .update(String(email).trim().toLowerCase())
    .digest('hex');
}

function normalizeDateOnly(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new AppError('Visit date must be YYYY-MM-DD', 400, { code: 'INVALID_VISIT_DATE' });
  }
  const at = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== text) {
    throw new AppError('Visit date must be YYYY-MM-DD', 400, { code: 'INVALID_VISIT_DATE' });
  }
  return text;
}

/** Mint an invite. The returned `proofRef` is what the review row stores. */
function mintReviewProof({
  venueId,
  proofMethod,
  email = null,
  visitDate = null,
  expiresInDays = DEFAULT_TTL_DAYS,
}) {
  if (!venueId) {
    throw new AppError('A venue is required for a review invite', 400, { code: 'INVALID_PROOF' });
  }
  if (!METHODS.includes(proofMethod)) {
    throw new AppError('Unknown proof method', 400, { code: 'INVALID_PROOF_METHOD' });
  }

  const ttlDays = Math.min(MAX_TTL_DAYS, Math.max(1, Number(expiresInDays) || DEFAULT_TTL_DAYS));
  const day = normalizeDateOnly(visitDate);
  const proofRef = crypto.randomUUID();
  const expiresAt = Date.now() + ttlDays * 24 * 60 * 60 * 1000;

  const payloadPart = encode(
    JSON.stringify({
      k: CLAIM_KIND,
      i: proofRef,
      v: venueId,
      p: proofMethod,
      w: day,
      h: emailHash(email),
      e: expiresAt,
    }),
  );
  const token = `${payloadPart}.${signatureFor(payloadPart)}`;

  return { token, proofRef, proofMethod, visitDate: day, expiresAt: new Date(expiresAt) };
}

/** Verify signature and claims; never trusts anything read off the token payload. */
function verifyReviewProof(token, { venueId = null, email = null } = {}) {
  if (!token || typeof token !== 'string') {
    throw new AppError('A review invite is required', 400, { code: 'INVALID_PROOF' });
  }

  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new AppError('Invalid review invite', 400, { code: 'INVALID_PROOF' });
  }
  if (!sameSignature(parts[1], signatureFor(parts[0]))) {
    throw new AppError('Invalid review invite', 403, { code: 'INVALID_PROOF' });
  }

  let claims;
  try {
    claims = decode(parts[0]);
  } catch {
    throw new AppError('Invalid review invite', 400, { code: 'INVALID_PROOF' });
  }
  if (!claims || claims.k !== CLAIM_KIND || !claims.i || !claims.v || !METHODS.includes(claims.p)) {
    throw new AppError('Invalid review invite', 400, { code: 'INVALID_PROOF' });
  }
  if (!Number.isFinite(claims.e) || claims.e <= Date.now()) {
    throw new AppError('This review invite has expired', 403, { code: 'PROOF_EXPIRED' });
  }
  if (venueId && claims.v !== venueId) {
    throw new AppError('This review invite is for another venue', 403, {
      code: 'PROOF_VENUE_MISMATCH',
    });
  }
  if (claims.h && !sameSignature(emailHash(email), claims.h)) {
    throw new AppError('This review invite was issued to someone else', 403, {
      code: 'PROOF_FOR_SOMEONE_ELSE',
    });
  }

  return {
    proofRef: claims.i,
    proofMethod: claims.p,
    visitDate: claims.w || null,
    expiresAt: new Date(claims.e),
  };
}

module.exports = {
  CLAIM_KIND,
  METHODS,
  DEFAULT_TTL_DAYS,
  emailHash,
  normalizeDateOnly,
  mintReviewProof,
  verifyReviewProof,
};
