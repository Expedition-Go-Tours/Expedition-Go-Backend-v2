const jwt = require('jsonwebtoken');

exports.createSessionToken = (user) => {
  return jwt.sign(
    {
      id: user.id,
      firebaseUid: user.firebaseUid,
      roles: user.roles,
      supplierStatus: user.supplierStatus,
      active: user.active,
    },
    process.env.JWT_SECRET,
    {
      expiresIn: '30d',
    }
  );
};
