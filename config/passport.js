const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const bcrypt = require('bcrypt');
const prisma = require('../src/core/services/prismaClient');
const { resolveGoogleUser } = require('../src/core/services/googleAccount');
const { BRAND_GOOGLE_ENV, googleConfigFor } = require('./googleBrands');

passport.use(
  new LocalStrategy(
    { usernameField: 'email', passwordField: 'password' },
    async (email, password, done) => {
      try {
        const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
        if (!user) return done(null, false, { message: 'Invalid email or password' });
        // A password is the credential. The provider field records how the
        // account was created and must not decide whether this login works.
        if (!user.passwordHash) {
          return done(null, false, {
            message: 'This account has no password. Sign in with Google or use the forgot password option to create one.',
          });
        }
        if (!user.active) return done(null, false, { message: 'Account has been deactivated' });

        const isMatch = await bcrypt.compare(password, user.passwordHash);
        if (!isMatch) return done(null, false, { message: 'Invalid email or password' });

        return done(null, user);
      } catch (err) {
        return done(err);
      }
    },
  ),
);

/**
 * Shared Google profile → user resolver. Runs for every brand's strategy so
 * account creation/linking is identical regardless of which client was used.
 */
async function verifyGoogleProfile(accessToken, refreshToken, profile, done) {
  try {
    const user = await resolveGoogleUser({
      email: profile.emails?.[0]?.value,
      name: profile.displayName,
      photoURL: profile.photos?.[0]?.value,
      googleId: profile.id,
    });
    return done(null, user);
  } catch (err) {
    // Operational refusals (deactivated account, unlinked admin) belong on the
    // login page, not as a 500.
    if (err && err.isOperational) {
      return done(null, false, { message: err.message });
    }
    return done(err);
  }
}

// Register one named strategy per brand that has credentials configured. The
// default brand keeps the name 'google'; others use 'google-<brand>' so the
// controller can authenticate against the client that matches the request.
for (const brand of Object.keys(BRAND_GOOGLE_ENV)) {
  const cfg = googleConfigFor(brand);
  if (!cfg.clientID || !cfg.clientSecret) continue;
  passport.use(
    cfg.strategy,
    new GoogleStrategy(
      {
        clientID: cfg.clientID,
        clientSecret: cfg.clientSecret,
        callbackURL: cfg.callbackURL,
        scope: ['profile', 'email'],
      },
      verifyGoogleProfile,
    ),
  );
}

module.exports = passport;
