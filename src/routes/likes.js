const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const auth = require('../middleware/auth');

const router = express.Router();

router.use(auth);

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });
  next();
}

// ── POST /api/likes ───────────────────────────────────────────────────────────
// Like a user. If the like is reciprocal, creates a match automatically.
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/',
  [body('liked_id').isUUID().withMessage('liked_id must be a valid UUID')],
  validate,
  async (req, res, next) => {
    const likerId = req.user.id;
    const likedId = req.body.liked_id;

    if (likerId === likedId) {
      return res.status(400).json({ error: 'You cannot like yourself' });
    }

    try {
      const insertLike = await pool.query(
        `INSERT INTO likes (liker_id, liked_id)
         VALUES ($1, $2)
         ON CONFLICT (liker_id, liked_id) DO NOTHING
         RETURNING id`,
        [likerId, likedId]
      );

      // Like already existed — idempotent response
      if (insertLike.rowCount === 0) {
        return res.status(200).json({ is_match: false });
      }

      const likeId = insertLike.rows[0].id;

      // Check for reciprocal like
      const reciprocal = await pool.query(
        `SELECT 1 FROM likes WHERE liker_id = $1 AND liked_id = $2`,
        [likedId, likerId]
      );

      if (reciprocal.rowCount === 0) {
        return res.status(201).json({ like_id: likeId, is_match: false });
      }

      // Reciprocal like exists → create match (user1_id < user2_id enforced by schema)
      const insertMatch = await pool.query(
        `INSERT INTO matches (user1_id, user2_id)
         VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid))
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [likerId, likedId]
      );

      const matchId = insertMatch.rows[0]?.id ?? null;
      return res.status(201).json({ like_id: likeId, is_match: true, match_id: matchId });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/likes/received ───────────────────────────────────────────────────
// Users who liked the current user and with whom no match exists yet.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/received', async (req, res, next) => {
  const userId = req.user.id;

  try {
    const { rows } = await pool.query(
      `SELECT
         u.id, u.name, u.profile_picture_url, u.city, u.birth_date,
         u.bio, u.tags, u.relation_type, u.height_cm, u.languages,
         u.astro_sign, u.education, u.job_title, u.company,
         u.family_plans, u.communication_style, u.love_language,
         u.pet, u.alcohol, u.tobacco, u.sport,
         u.evenings_type, u.weekends_type, u.favorite_song, u.gender,
         l.created_at AS liked_at
       FROM likes l
       JOIN users u ON u.id = l.liker_id
       WHERE l.liked_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM matches m
           WHERE m.user1_id = LEAST($1, l.liker_id)
             AND m.user2_id = GREATEST($1, l.liker_id)
         )
       ORDER BY l.created_at DESC`,
      [userId]
    );

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── GET /api/likes/sent ───────────────────────────────────────────────────────
router.get('/sent', (_req, res) => {
  res.status(501).json({ error: 'Not implemented' });
});

module.exports = router;
