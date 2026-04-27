const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const auth = require('../middleware/auth');
const { notBlockedClause } = require('../db/blocks');
const { shouldBeInPool } = require('../services/poolGate');
const { handlePoolTransition } = require('../services/poolTransition');

const router = express.Router();

router.use(auth);

const VOTES_REQUIRED = 20;
const PROFILES_PER_BATCH = 5;

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });
  next();
}

// ── GET /api/arena/profiles ───────────────────────────────────────────────────
// Returns up to 5 profiles the authenticated user has not yet rated.
// Excludes: self, already-voted profiles, users not yet in the pool.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/profiles', async (req, res, next) => {
  try {
    // seeking = null or 'all' → no gender filter; 'male'/'female' → filter on u.gender
    const seeking = req.user.seeking;
    const genderFilter = (seeking === 'male' || seeking === 'female') ? seeking : null;

    const { rows } = await pool.query(
      `SELECT
         u.id,
         u.name,
         u.birth_date,
         u.city,
         u.bio,
         u.profile_picture_url,
         u.tags,
         u.relation_type,
         u.family_plans,
         u.communication_style,
         u.love_language,
         u.height_cm,
         u.languages,
         u.astro_sign,
         u.education,
         u.job_title,
         u.company,
         u.pet,
         u.alcohol,
         u.tobacco,
         u.sport,
         u.evenings_type,
         u.weekends_type,
         u.favorite_song,
         u.gender,
         u.avg_rating
       FROM users u
       WHERE u.id        != $1
         AND u.is_active  = TRUE
         AND ${notBlockedClause('$1', 'u')}
         AND NOT EXISTS (
           SELECT 1 FROM arena_votes av
           WHERE av.voter_id = $1
             AND av.voted_id = u.id
         )
         AND ($3::TEXT IS NULL OR u.gender = $3)
       ORDER BY u.is_in_pool ASC NULLS FIRST, RANDOM()
       LIMIT $2`,
      [req.user.id, PROFILES_PER_BATCH, genderFilter]
    );

    res.json({
      profiles:         rows,
      count:            rows.length,
      no_more_profiles: rows.length < PROFILES_PER_BATCH,
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/arena/vote ──────────────────────────────────────────────────────
// Body: { voted_id: uuid, rating: 1–10 }
// Inserts arena_votes row, updates voter's votes_given + is_in_pool,
// recalculates the voted profile's avg_rating.
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/vote',
  [
    body('voted_id')
      .isUUID()
      .withMessage('voted_id must be a valid UUID'),
    body('rating')
      .isInt({ min: 1, max: 10 })
      .withMessage('rating must be an integer between 1 and 10'),
  ],
  validate,
  async (req, res, next) => {
    const { voted_id, rating } = req.body;
    const voter_id       = req.user.id;
    const voterWasInPool = req.user.is_in_pool === true;

    if (voted_id === voter_id) {
      return res.status(400).json({ error: 'Cannot vote on your own profile' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1 — Insert vote (unique constraint catches duplicates)
      await client.query(
        `INSERT INTO arena_votes (voter_id, voted_id, rating)
         VALUES ($1, $2, $3)`,
        [voter_id, voted_id, rating]
      );

      // 2 — Increment voter's votes_given, then re-evaluate pool eligibility
      const { rows: voterRows } = await client.query(
        `UPDATE users
         SET arena_votes_given = arena_votes_given + 1
         WHERE id = $1
         RETURNING arena_votes_given, arena_votes_received, avg_rating, completude_pct`,
        [voter_id]
      );

      const newIsInPool = shouldBeInPool(voterRows[0]);
      await client.query(
        `UPDATE users SET is_in_pool = $1 WHERE id = $2`,
        [newIsInPool, voter_id]
      );

      // 3a — Snapshot voted user's current pool status before any update
      const { rows: votedBefore } = await client.query(
        `SELECT is_in_pool FROM users WHERE id = $1`,
        [voted_id]
      );
      const votedWasInPool = votedBefore[0]?.is_in_pool === true;

      // 3b — Recalculate avg_rating for the voted profile (must run before shouldBeInPool check)
      await client.query(
        `UPDATE users
         SET avg_rating = (
           SELECT ROUND(AVG(rating)::NUMERIC, 2)
           FROM arena_votes
           WHERE voted_id = $1
         )
         WHERE id = $1`,
        [voted_id]
      );

      // 4 — Increment votes_received and fetch fresh data (avg_rating already updated above)
      const { rows: votedRows } = await client.query(
        `UPDATE users
         SET arena_votes_received = arena_votes_received + 1
         WHERE id = $1
         RETURNING completude_pct, arena_votes_given, arena_votes_received, avg_rating`,
        [voted_id]
      );

      const votedNewIsInPool = shouldBeInPool(votedRows[0]);
      await client.query(
        `UPDATE users SET is_in_pool = $1 WHERE id = $2`,
        [votedNewIsInPool, voted_id]
      );

      await client.query('COMMIT');

      const io = req.app.get('io');
      io.to(`user:${voted_id}`).emit('new_rating', {
        rating,
        new_avg_rating:     votedRows[0].avg_rating,
        new_votes_received: votedRows[0].arena_votes_received,
      });

      await handlePoolTransition({
        io,
        userId:        voter_id,
        wasInPool:     voterWasInPool,
        isInPool:      newIsInPool,
        completudePct: voterRows[0].completude_pct,
      });
      await handlePoolTransition({
        io,
        userId:        voted_id,
        wasInPool:     votedWasInPool,
        isInPool:      votedNewIsInPool,
        completudePct: votedRows[0].completude_pct,
      });

      const { arena_votes_given } = voterRows[0];

      res.status(201).json({
        success:         true,
        votes_given:     arena_votes_given,
        is_in_pool:      newIsInPool,
        remaining_votes: Math.max(0, VOTES_REQUIRED - arena_votes_given),
      });
    } catch (err) {
      await client.query('ROLLBACK');
      // Unique violation = already voted on this profile
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Already voted on this profile' });
      }
      next(err);
    } finally {
      client.release();
    }
  }
);

// ── GET /api/arena/my-stats ───────────────────────────────────────────────────
// Returns vote statistics for the authenticated user.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/my-stats', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         u.arena_votes_given                                    AS votes_given,
         u.is_in_pool,
         u.avg_rating,
         COUNT(av.id)::INT                                      AS votes_received,
         GREATEST(0, $2 - u.arena_votes_given)                 AS remaining_votes
       FROM users u
       LEFT JOIN arena_votes av ON av.voted_id = u.id
       WHERE u.id = $1
       GROUP BY u.id`,
      [req.user.id, VOTES_REQUIRED]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
