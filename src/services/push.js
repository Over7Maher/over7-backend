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

async function sendPushToUser(userId, title, body, data = {}) {
  try {
    const { rows } = await pool.query(
      'SELECT push_token FROM users WHERE id = $1',
      [userId]
    );
    const token = rows[0]?.push_token;
    if (!token) return;
    await sendPush(token, title, body, data);
  } catch (err) {
    console.error('[push] sendPushToUser error:', err.message);
  }
}

module.exports = { sendPush, sendPushToUser };
