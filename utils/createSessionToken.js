const jwt = require('jsonwebtoken');

exports.createSessionToken = (user) => {
  return jwt.sign(
    {
      id: user.id,
      roles: user.roles,
      supplierStatus: user.supplierStatus
    },
    process.env.JWT_SECRET,
    {
      expiresIn: '30d'
    }
  );
};