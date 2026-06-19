const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const bcrypt = require('bcrypt');
const prisma = require('../utils/prismaClient');

passport.use(
  new LocalStrategy(
    { usernameField: 'email', passwordField: 'password' },
    async (email, password, done) => {
      try {
        const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
        if (!user) return done(null, false, { message: 'Invalid email or password' });
        if (!user.passwordHash && user.authProvider !== 'local') return done(null, false, { message: 'This account uses social login. Please sign in with Google.' });
        if (!user.passwordHash && user.authProvider === 'local') return done(null, false, { message: 'Password not set. Please use the forgot password option to create one.' });
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

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:5000/api/auth/google/callback',
        scope: ['profile', 'email'],
      },
      async (accessToken, refreshToken, profile, done) => {
        try {
          const email = profile.emails?.[0]?.value?.toLowerCase().trim();
          if (!email) return done(null, false, { message: 'No email found from Google' });

          let user = await prisma.user.findUnique({ where: { email } });

          if (user) {
            if (!user.firebaseUid) {
              user = await prisma.user.update({
                where: { id: user.id },
                data: {
                  authProvider: 'google',
                  name: user.name || profile.displayName,
                  photoURL: user.photoURL || profile.photos?.[0]?.value || '',
                },
              });
            }
          } else {
            user = await prisma.user.create({
              data: {
                email,
                name: profile.displayName,
                photoURL: profile.photos?.[0]?.value || '',
                authProvider: 'google',
                roles: ['customer'],
              },
            });
          }

          if (!user.active) return done(null, false, { message: 'Account has been deactivated' });

          return done(null, user);
        } catch (err) {
          return done(err);
        }
      },
    ),
  );
}

module.exports = passport;
