const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db/pool');
const auth = require('../middleware/auth');

const router = express.Router();
const MESSAGES_LIMIT = 50;

router.use(auth);

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });
  next();
}

// ── Helper: verify match membership ──────────────────────────────────────────
async function getMembership(matchId, userId) {
  const { rows } = await pool.query(
    `SELECT id, user1_id, user2_id
     FROM matches
     WHERE id = $1
       AND (user1_id = $2 OR user2_id = $2)
       AND is_active = TRUE`,
    [matchId, userId]
  );
  return rows[0] ?? null;
}

// ── GET /api/messages/:matchId ────────────────────────────────────────────────
// Returns the 50 most recent messages, oldest-first for display.
// Marks all incoming unread messages as read in the same transaction.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/:matchId',
  [param('matchId').isUUID().withMessage('matchId must be a valid UUID')],
  validate,
  async (req, res, next) => {
    const { matchId } = req.params;
    const userId = req.user.id;

    try {
      const match = await getMembership(matchId, userId);
      if (!match) return res.status(404).json({ error: 'Match not found or access denied' });

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Mark incoming unread messages as read
        await client.query(
          `UPDATE messages
           SET read_at = NOW()
           WHERE match_id = $1
             AND sender_id != $2
             AND read_at IS NULL`,
          [matchId, userId]
        );

        // Fetch last N messages, return in chronological order
        const { rows } = await client.query(
          `SELECT
             m.id,
             m.match_id,
             m.sender_id,
             m.content,
             m.read_at,
             m.created_at,
             u.name AS sender_name
           FROM messages m
           JOIN users u ON u.id = m.sender_id
           WHERE m.match_id = $1
           ORDER BY m.created_at DESC
           LIMIT $2`,
          [matchId, MESSAGES_LIMIT]
        );

        await client.query('COMMIT');

        // Reverse so oldest message is first (chronological for chat UI)
        res.json(rows.reverse());
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/messages/:matchId ───────────────────────────────────────────────
// Inserts a message and broadcasts it via Socket.io to the match room.
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/:matchId',
  [
    param('matchId').isUUID().withMessage('matchId must be a valid UUID'),
    body('content')
      .isString().withMessage('content must be a string')
      .trim()
      .notEmpty().withMessage('content cannot be empty')
      .isLength({ max: 1000 }).withMessage('content exceeds 1000 characters'),
  ],
  validate,
  async (req, res, next) => {
    const { matchId } = req.params;
    const { content }  = req.body;
    const userId       = req.user.id;

    try {
      const match = await getMembership(matchId, userId);
      if (!match) return res.status(404).json({ error: 'Match not found or access denied' });

      const { rows } = await pool.query(
        `INSERT INTO messages (id, match_id, sender_id, content)
         VALUES ($1, $2, $3, $4)
         RETURNING id, match_id, sender_id, content, read_at, created_at`,
        [uuidv4(), matchId, userId, content.trim()]
      );

      const message = { ...rows[0], sender_name: req.user.name };

      const io = req.app.get('io');
      if (io) {
        // Broadcast to all sockets in the match room (including sender's other devices)
        io.to(`match:${matchId}`).emit('new_message', message);

        // Notify the other participant's personal room so offscreen badge updates in real time
        const otherUserId = match.user1_id === userId ? match.user2_id : match.user1_id;
        io.to(`user:${otherUserId}`).emit('notification', {
          type:     'new_message',
          match_id: matchId,
        });
      }

      res.status(201).json(message);
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
