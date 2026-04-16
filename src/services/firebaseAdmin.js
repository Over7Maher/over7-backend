const admin = require('firebase-admin');

// Lazy init: only call initializeApp when the module is first used at runtime,
// so the server can boot without Firebase credentials (e.g. during local dev
// without a .env, or in unit tests that mock this module).
function getAdmin() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        // .env stores the key with literal \n — replace to real newlines
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  }
  return admin;
}

module.exports = getAdmin;
