const SESSION_COOKIE_NAME = 'session';

exports.sendSessionCookie = (res, token) => {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    domain:
      process.env.NODE_ENV === 'production'
        ? '.travioafrica.com'
        : undefined,
    path: '/',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
};
