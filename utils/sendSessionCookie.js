const SESSION_COOKIE_NAME = 'session';

exports.sendSessionCookie = (res, token) => {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
};
