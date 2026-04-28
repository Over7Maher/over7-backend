const pool = require('../db/pool');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const MAX_PUSH_ATTEMPTS = 3;

async function sendPush(pushToken, title, body, data = {}, attempt = 1) {
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to:        pushToken,
        title,
        body,
        data,
        sound:     'default',
        priority:  'high',
        channelId: 'default',
      }),
    });

    const json = await res.json().catch(() => null);
    const ticket = Array.isArray(json?.data) ? json.data[0] : json?.data;

    if (!ticket) {
      console.error('[push] unexpected Expo response:', json);
      return { ok: false, code: 'unexpected_response' };
    }

    if (ticket.status === 'error') {
      const code = ticket.details?.error || 'unknown_error';

      // Transient: Expo rate-limits at 600 push/sec/app. Exponential backoff
      // 1s, then 2s. Max 3 attempts → worst-case 3s of waits before giving up.
      // Other Expo error codes (DeviceNotRegistered, MessageTooBig, etc.) are
      // not transient — handled by the caller (sendPushToUser nullifies stale
      // tokens) or by the application (caller bug / infra config).
      if (code === 'MessageRateExceeded' && attempt < MAX_PUSH_ATTEMPTS) {
        const backoffMs = 1000 * Math.pow(2, attempt - 1);
        console.warn(`[push] MessageRateExceeded, retrying in ${backoffMs}ms (attempt ${attempt}/${MAX_PUSH_ATTEMPTS})`);
        await sleep(backoffMs);
        return sendPush(pushToken, title, body, data, attempt + 1);
      }

      console.error('[push] Expo error:', {
        code,
        message: ticket.message,
        token:   pushToken.slice(0, 30) + '…',
        attempt,
      });
      return { ok: false, code, message: ticket.message };
    }

    return { ok: true, ticketId: ticket.id };
  } catch (err) {
    console.error('[push] sendPush network error:', err.message);
    return { ok: false, code: 'network_error', message: err.message };
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

    const result = await sendPush(token, title, body, data);

    if (!result.ok && result.code === 'DeviceNotRegistered') {
      // Token is stale (uninstall, push permission revoked, app reset).
      // The AND push_token = $2 guard avoids clobbering a fresh token the user
      // may have registered between the failed push and this nullify.
      try {
        await pool.query(
          `UPDATE users SET push_token = NULL WHERE id = $1 AND push_token = $2`,
          [userId, token]
        );
        console.log('[push] cleared invalid token for user', userId);
      } catch (err) {
        console.error('[push] failed to clear invalid token:', err.message);
      }
    }
  } catch (err) {
    console.error('[push] sendPushToUser error:', err.message);
  }
}

module.exports = { sendPush, sendPushToUser };
