const prisma = require('./prismaClient');
const AppError = require('./appError');

/**
 * Resolve a verified Google profile to a user.
 *
 * Google is a credential, not a mode. For an existing account this only fills
 * in the Google identity (`firebaseUid`) and verification facts; it never
 * rewrites `authProvider`, which records how the account was created.
 *
 * Admin accounts must already have a linked Google identity. Auto-linking an
 * admin who was created with a password would let whoever controls that Gmail
 * address into the console without it.
 */
async function resolveGoogleUser({ email, name, photoURL, googleId }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) {
    throw new AppError('No email found from Google', 401);
  }

  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });

  if (!existing) {
    return prisma.user.create({
      data: {
        email: normalizedEmail,
        name: name || '',
        photoURL: photoURL || '',
        authProvider: 'google',
        firebaseUid: googleId || null,
        roles: ['customer'],
        emailVerified: true,
        emailVerifiedAt: new Date(),
      },
    });
  }

  if (!existing.active) {
    throw new AppError('Account has been deactivated', 403);
  }

  // `firebaseUid` is the durable Google identity. `authProvider === 'google'`
  // covers accounts created through the OAuth callback before it stored the
  // UID; those admins already had Google access and must not be locked out.
  const hasGoogleIdentity = Boolean(existing.firebaseUid) || existing.authProvider === 'google';

  if (existing.roles.includes('admin') && !hasGoogleIdentity) {
    throw new AppError(
      'Use your password to sign in, then link Google from account settings.',
      403,
    );
  }

  return prisma.user.update({
    where: { id: existing.id },
    data: {
      // Link Google on first use, but never replace an existing identity and
      // never touch authProvider for an account that already exists.
      firebaseUid: existing.firebaseUid || googleId || undefined,
      name: existing.name || name,
      photoURL: existing.photoURL || photoURL || '',
      emailVerified: true,
      emailVerifiedAt: existing.emailVerifiedAt || new Date(),
    },
  });
}

module.exports = { resolveGoogleUser };
