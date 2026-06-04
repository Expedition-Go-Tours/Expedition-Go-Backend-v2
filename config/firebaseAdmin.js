const admin = require('firebase-admin');

function getServiceAccountConfig() {
  const {
    FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY,
  } = process.env;

  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    return null;
  }

  return {
    projectId: FIREBASE_PROJECT_ID,
    clientEmail: FIREBASE_CLIENT_EMAIL,
    privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  };
}

const cfg = getServiceAccountConfig();
if (cfg && !admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(cfg) });
}

module.exports = admin;