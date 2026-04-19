const express = require('express');
const { body, param, validationResult } = require('express-validator');
const pool = require('../db/pool');
const auth = require('../middleware/auth');

const router = express.Router();

router.use(auth);

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });
  next();
}

// ── POST /api/blocks ──────────────────────────────────────────────────────────
// Block a user. Deactivates any existing match between the two users.
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/',
  [body('blocked_id').isUUID().withMessage('blocked_id must be a valid UUID')],
  validate,
  async (req, res, next) => {
    const blockerId = req.user.id;
    const { blocked_id } = req.body;

    if (blockerId === blocked_id) {
      return res.status(400).json({ error: 'You cannot block yourself' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO blocks (blocker_id, blocked_id)
         VALUES ($1, $2)
         ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
        [blockerId, blocked_id]
      );

      const { rows: matchRows } = await client.query(
        `UPDATE matches
         SET is_active = FALSE
         WHERE user1_id = LEAST($1::uuid, $2::uuid)
           AND user2_id = GREATEST($1::uuid, $2::uuid)
           AND is_active = TRUE
         RETURNING id`,
        [blockerId, blocked_id]
      );

      await client.query('COMMIT');

      if (matchRows.length > 0) {
        const io = req.app.get('io');
        if (io) {
          const matchId = matchRows[0].id;
          io.to(`user:${blockerId}`).emit('match_cancelled', { match_id: matchId });
          io.to(`user:${blocked_id}`).emit('match_cancelled', { match_id: matchId });
        }
      }

      res.status(204).end();
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  }
);

// ── DELETE /api/blocks/:blockedId ─────────────────────────────────────────────
// Unblock a user.
// ─────────────────────────────────────────────────────────────────────────────
router.delete(
  '/:blockedId',
  [param('blockedId').isUUID().withMessage('blockedId must be a valid UUID')],
  validate,
  async (req, res, next) => {
    try {
      await pool.query(
        `DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`,
        [req.user.id, req.params.blockedId]
      );
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
