const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const auth = require('../middleware/auth');
const haversineSQL = require('../db/haversine');
const { notBlockedClause } = require('../db/blocks');
const { sendPushToUser } = require('../services/push');

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
      const io = req.app.get('io');

      const insertLike = await pool.query(
        `INSERT INTO likes (liker_id, liked_id)
         VALUES ($1, $2)
         ON CONFLICT (liker_id, liked_id) DO NOTHING
         RETURNING id`,
        [likerId, likedId]
      );

      // null when the like already existed (ON CONFLICT DO NOTHING)
      const likeId = insertLike.rows[0]?.id ?? null;
      const status  = likeId ? 201 : 200;

      // Check for reciprocal like even if the like already existed —
      // the match may not have been created on the original insert.
      const reciprocal = await pool.query(
        `SELECT 1 FROM likes WHERE liker_id = $1 AND liked_id = $2`,
        [likedId, likerId]
      );

      if (reciprocal.rowCount === 0) {
        if (io && likeId) {
          io.to(`user:${likedId}`).emit('new_like', {
            liker_id:   likerId,
            liker_name: req.user.name,
          });
        }
        return res.status(status).json({ like_id: likeId, is_match: false });
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

      if (io && matchId) {
        const { rows: likedRows } = await pool.query(
          `SELECT name FROM users WHERE id = $1`,
          [likedId]
        );
        const likedName = likedRows[0]?.name ?? '';

        io.to(`user:${likerId}`).emit('new_match', {
          match_id:   matchId,
          other_id:   likedId,
          other_name: likedName,
        });
        io.to(`user:${likedId}`).emit('new_match', {
          match_id:   matchId,
          other_id:   likerId,
          other_name: req.user.name,
        });

        sendPushToUser(likerId, 'Nouveau match !', `${likedName} a matché avec toi`, { match_id: matchId, type: 'new_match' });
        sendPushToUser(likedId, 'Nouveau match !', `${req.user.name} a matché avec toi`, { match_id: matchId, type: 'new_match' });
      }

      return res.status(status).json({ like_id: likeId, is_match: true, match_id: matchId });
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /api/likes/:id/dismiss ─────────────────────────────────────────────
// Soft-deletes a received like without removing the row.
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/dismiss', async (req, res, next) => {
  try {
    const likeId = req.params.id;

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(likeId)) {
      return res.status(400).json({ error: 'invalid like id' });
    }

    const result = await pool.query(
      `UPDATE likes
       SET dismissed_at = NOW()
       WHERE id = $1 AND liked_id = $2 AND dismissed_at IS NULL
       RETURNING id`,
      [likeId, req.user.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'like not found or already dismissed' });
    }

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ── GET /api/likes/received ───────────────────────────────────────────────────
// Users who liked the current user and with whom no match exists yet.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/received', async (req, res, next) => {
  const userId = req.user.id;
  const myLat  = req.user.latitude  ?? null;
  const myLng  = req.user.longitude ?? null;

  try {
    const { rows } = await pool.query(
      `SELECT
         l.id AS like_id,
         u.id, u.name, u.profile_picture_url, u.city, u.birth_date,
         u.bio, u.tags, u.relation_type, u.height_cm, u.languages,
         u.astro_sign, u.education, u.job_title, u.company,
         u.family_plans, u.communication_style, u.love_language,
         u.pet, u.alcohol, u.tobacco, u.sport,
         u.evenings_type, u.weekends_type, u.favorite_song, u.gender,
         l.created_at AS liked_at,
         ${haversineSQL('$2', '$3', 'u')} AS dist_km
       FROM likes l
       JOIN users u ON u.id = l.liker_id
       WHERE l.liked_id = $1
         AND l.dismissed_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM matches m
           WHERE m.user1_id = LEAST($1, l.liker_id)
             AND m.user2_id = GREATEST($1, l.liker_id)
         )
         AND ${notBlockedClause('$1', 'u')}
       ORDER BY l.created_at DESC`,
      [userId, myLat, myLng]
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
