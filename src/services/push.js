const pool = require('../db/pool');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

async function sendPush(pushToken, title, body, data = {}) {
  try {
    await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: pushToken, title, body, data, sound: 'default' }),
    });
  } catch (err) {
    console.error('[push] sendPush error:', err.message);
  }
}

async function sendPushToUser(userId, title, body, data = {}, category = null) {
  try {
    const { rows } = await pool.query(
      'SELECT push_token, notification_preferences FROM users WHERE id = $1',
      [userId]
    );
    const token = rows[0]?.push_token;
    const prefs = rows[0]?.notification_preferences ?? {};
    if (!token) return;
    if (category && prefs[category] === false) {
      console.log(`[push] skipped ${category} for user ${userId} (opt-out)`);
      return;
    }
    await sendPush(token, title, body, data);
  } catch (err) {
    console.error('[push] sendPushToUser error:', err.message);
  }
}

module.exports = { sendPush, sendPushToUser };
