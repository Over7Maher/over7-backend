const express = require('express');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db/pool');

const router = express.Router();

// ── POST /api/test/send-message-from ─────────────────────────────────────────
// DEV ONLY — simulates a message from any user without Firebase auth.
// Body: { from_user_id, match_id, content }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/send-message-from', async (req, res, next) => {
  const { from_user_id, match_id, content } = req.body;

  if (!from_user_id || !match_id || !content) {
    return res.status(400).json({ error: 'from_user_id, match_id and content are required' });
  }

  try {
    const matchResult = await pool.query(
      `SELECT user1_id, user2_id, u.name AS sender_name
       FROM matches
       JOIN users u ON u.id = $2
       WHERE matches.id = $1 AND matches.is_active = TRUE`,
      [match_id, from_user_id]
    );

    if (!matchResult.rows.length) {
      return res.status(404).json({ error: 'Match not found or inactive' });
    }

    const { user1_id, user2_id, sender_name } = matchResult.rows[0];
    const otherUserId = user1_id === from_user_id ? user2_id : user1_id;

    const { rows } = await pool.query(
      `INSERT INTO messages (id, match_id, sender_id, content)
       VALUES ($1, $2, $3, $4)
       RETURNING id, match_id, sender_id, content, read_at, created_at`,
      [uuidv4(), match_id, from_user_id, content.trim()]
    );

    const message = { ...rows[0], sender_name };

    const io = req.app.get('io');
    if (io) {
      io.to(`match:${match_id}`).emit('new_message', message);
      io.to(`user:${otherUserId}`).emit('notification', {
        type:     'new_message',
        match_id,
      });
    }

    res.status(201).json(message);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
