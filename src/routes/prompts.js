const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const auth = require('../middleware/auth');
const { calculateCompletude } = require('../services/completude');
const { shouldBeInPool } = require('../services/poolGate');
const formatUser = require('../utils/formatUser');

const router = express.Router();

router.use(auth);

const MAX_PROMPTS = 5;
const MAX_ANSWER_LEN = 150;

// ── GET /api/prompts/catalog ──────────────────────────────────────────────────
// Read-only list of the 25 predefined prompts.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/catalog', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, question, category, position
       FROM prompts_catalog
       ORDER BY position ASC`
    );
    res.json({ prompts: rows });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/prompts/mine ─────────────────────────────────────────────────────
// Returns the current user's answered prompts (ordered by position).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/mine', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT up.id, up.prompt_id, up.answer, up.position,
              pc.question, pc.category
       FROM user_prompts up
       JOIN prompts_catalog pc ON pc.id = up.prompt_id
       WHERE up.user_id = $1
       ORDER BY up.position ASC`,
      [req.user.id]
    );
    res.json({ prompts: rows });
  } catch (err) {
    next(err);
  }
});

// ── PUT /api/prompts/mine ─────────────────────────────────────────────────────
// Body: { prompts: [{ prompt_id, answer }, ...] } — max 5 entries.
// Replaces all existing answers atomically. Recomputes completude_pct and
// pool eligibility; emits pool_unlocked on a false → true transition.
// ─────────────────────────────────────────────────────────────────────────────
router.put(
  '/mine',
  [body('prompts').isArray({ max: MAX_PROMPTS }).withMessage(`Max ${MAX_PROMPTS} prompts`)],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const userId  = req.user.id;
    const prompts = req.body.prompts || [];

    for (const p of prompts) {
      if (!p.prompt_id || typeof p.prompt_id !== 'string') {
        return res.status(400).json({ error: 'prompt_id required for each entry' });
      }
      if (!p.answer || typeof p.answer !== 'string') {
        return res.status(400).json({ error: 'answer required for each entry' });
      }
      const trimmed = p.answer.trim();
      if (trimmed.length === 0 || trimmed.length > MAX_ANSWER_LEN) {
        return res.status(400).json({ error: `answer must be 1-${MAX_ANSWER_LEN} characters` });
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(`DELETE FROM user_prompts WHERE user_id = $1`, [userId]);

      for (let i = 0; i < prompts.length; i++) {
        await client.query(
          `INSERT INTO user_prompts (user_id, prompt_id, answer, position, updated_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [userId, prompts[i].prompt_id, prompts[i].answer.trim(), i]
        );
      }

      // Recompute completude + pool eligibility with the new prompts count
      const newPct     = calculateCompletude(req.user, prompts.length);
      const wasInPool  = req.user.is_in_pool === true;
      const newInPool  = shouldBeInPool({ ...req.user, completude_pct: newPct });

      const { rows: updatedRows } = await client.query(
        `UPDATE users SET completude_pct = $1, is_in_pool = $2 WHERE id = $3 RETURNING *`,
        [newPct, newInPool, userId]
      );

      await client.query('COMMIT');

      if (!wasInPool && newInPool) {
        const io = req.app.get('io');
        io.to(`user:${userId}`).emit('pool_unlocked');
        await pool.query(
          `UPDATE users SET pool_unlocked_pending = TRUE, pool_unlocked_at = NOW()
           WHERE id = $1 AND pool_unlocked_at IS NULL`,
          [userId]
        );
      }

      res.json(formatUser(updatedRows[0]));
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  }
);

module.exports = router;
