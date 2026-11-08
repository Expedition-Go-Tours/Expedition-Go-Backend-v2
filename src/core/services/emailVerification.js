/**
 * Email verification.
 *
 * The account email is the identity the guest-claim flow relies on, so it has
 * to be proved before any booking is attached. Google and a completed password
 * reset prove inbox control already; this module covers the password-account
 * path with a signed, 24-hour link.
 *
 * The token is bound to `{ userId, email }`: changing the account email
 * invalidates every outstanding link. Replaying a token after verification is
 * harmless (it only sets a boolean that is already true), so no token table is
 * needed.
 */
const prisma = require('./prismaClient');
const AppError = require('./appError');
const { sendEmail } = require('./emailService');
const { signEmailVerifyToken, verifyEmailVerifyToken } = require('../../../config/jwt');

const DEFAULT_ORIGIN = process.env.GHANA_STOREFRONT_URL || 'https://www.travioghana.com';

function invalidLink() {
  return new AppError(
    'This verification link is invalid or has expired. Request a new one from your account.',
    400,
    { code: 'EMAIL_VERIFY_INVALID', reasonCode: 'EMAIL_VERIFY_INVALID' },
  );
}

function brandForOrigin(origin) {
  let host = '';
  try {
    host = new URL(String(origin)).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return 'ghana';
  }
  if (host === 'expeditiongotours.com' || host.endsWith('.expeditiongotours.com')) return 'expedition';
  if (host === 'travioafrica.com' || host.endsWith('.travioafrica.com')) return 'africa';
  return 'ghana';
}

function verificationUrl(origin, token) {
  const base = String(origin || DEFAULT_ORIGIN).replace(/\/+$/, '');
  return `${base}/verify-email?token=${encodeURIComponent(token)}`;
}

/**
 * Send (or resend) the verification email. Safe to call for an already
 * verified account: it reports the state instead of mailing again.
 *
 * @param {{ id: string, email: string, name?: string, emailVerified?: boolean }} user
 * @param {string} [origin] allow-listed storefront origin
 */
async function sendVerificationEmail(user, origin) {
  if (!user?.id || !user?.email) throw new Error('sendVerificationEmail needs a user with an email');
  if (user.emailVerified) return { alreadyVerified: true };

  const token = signEmailVerifyToken({ userId: user.id, email: user.email });
  const url = verificationUrl(origin, token);

  await sendEmail({
    to: user.email,
    subject: 'Verify your email to manage your booking',
    template: 'verify-email',
    opts: { brandKey: brandForOrigin(origin) },
    data: {
      customerName: user.name || 'there',
      verifyUrl: url,
      preheader: 'Confirm your email address to see and manage bookings made as a guest.',
    },
  });

  return { sent: true };
}

/**
 * Confirm a verification token.
 *
 * @param {unknown} rawToken
 * @returns {Promise<{ alreadyVerified: boolean, user: { id: string, email: string, emailVerified: true } }>}
 */
async function confirmEmailVerificationToken(rawToken) {
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!token || token.length > 2000) throw invalidLink();

  let payload;
  try {
    payload = verifyEmailVerifyToken(token);
  } catch {
    throw invalidLink();
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { id: true, email: true, emailVerified: true },
  });
  if (!user) throw invalidLink();

  // A link sent to an old address must not verify the new one. The account
  // owner can request a fresh link after changing the address.
  if (String(user.email).toLowerCase() !== String(payload.email).toLowerCase()) {
    throw new AppError(
      'This verification link was sent to a different email address. Request a new link from your account.',
      400,
      { code: 'EMAIL_VERIFY_EMAIL_CHANGED', reasonCode: 'EMAIL_VERIFY_EMAIL_CHANGED' },
    );
  }

  if (user.emailVerified) {
    return {
      alreadyVerified: true,
      user: { id: user.id, email: user.email, emailVerified: true },
    };
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { emailVerified: true, emailVerifiedAt: new Date() },
    select: { id: true, email: true, emailVerified: true },
  });

  return { alreadyVerified: false, user: updated };
}

module.exports = {
  sendVerificationEmail,
  confirmEmailVerificationToken,
  brandForOrigin,
  verificationUrl,
};
