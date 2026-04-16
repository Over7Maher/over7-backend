const getAdmin = require('../services/firebaseAdmin');
const pool     = require('../db/pool');

/**
 * Verifies the Firebase ID Token from Authorization: Bearer <token>,
 * looks up the user row in the database, and attaches it to req.user.
 */
async function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  const idToken = header.slice(7);

  try {
    const decoded = await getAdmin().auth().verifyIdToken(idToken);
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE firebase_uid = $1 AND is_active = TRUE',
      [decoded.uid]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'User not found or inactive' });
    }

    req.user = rows[0];
    next();
  } catch (err) {
    if (err.code === 'auth/id-token-expired') {
      return res.status(401).json({ error: 'Token expired' });
    }
    if (err.code === 'auth/argument-error' || err.code === 'auth/id-token-revoked') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    next(err);
  }
}

module.exports = auth;
