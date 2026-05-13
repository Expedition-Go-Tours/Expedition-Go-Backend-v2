exports.sendSessionCookie = (res, token) => {
  res.cookie('session', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    domain:
      process.env.NODE_ENV === 'production'
        ? '.travioafrica.com'
        : undefined,
    maxAge: 30 * 24 * 60 * 60 * 1000
  });
};