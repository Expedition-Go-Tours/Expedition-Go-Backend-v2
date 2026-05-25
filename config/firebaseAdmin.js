const admin = require('firebase-admin');

function getServiceAccountConfig() {
  const {
    FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY,
  } = process.env;

  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    throw new Error(
      'Missing Firebase Admin env vars: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY',
    );
  }

  return {
    projectId: FIREBASE_PROJECT_ID,
    clientEmail: FIREBASE_CLIENT_EMAIL,
    privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  };
}

// Development: use a lightweight stub that only supports the dev test-token bypass
if (process.env.NODE_ENV === 'development') {
  console.log('Firebase admin: running in development mode — using stubbed admin');
  module.exports = {
    auth: () => ({
      verifyIdToken: async () => {
        throw new Error('Firebase admin disabled in development — use dev auth bypass');
      },
    }),
    apps: [],
  };
} else {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(getServiceAccountConfig()),
    });

    console.log(
      'DEBUG: Admin SDK Project ID:',
      admin.app().options.credential.projectId || 'Check service account JSON',
    );
  }

  module.exports = admin;
}