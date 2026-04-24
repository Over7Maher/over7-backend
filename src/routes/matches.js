const express = require('express');
const { param, validationResult } = require('express-validator');
const pool = require('../db/pool');
const auth = require('../middleware/auth');
const haversineSQL = require('../db/haversine');
const { notBlockedClause } = require('../db/blocks');

const router = express.Router();

router.use(auth);

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });
  next();
}

// ── GET /api/matches ──────────────────────────────────────────────────────────
// Returns all active matches for the authenticated user with:
//   - other user's display name and first photo
//   - last message (content + timestamp)
//   - unread count (messages sent by the other user with read_at IS NULL)
// Ordered by most recent activity (last message or match creation date).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  const userId = req.user.id;
  const myLat  = req.user.latitude  ?? null;
  const myLng  = req.user.longitude ?? null;

  try {
    const { rows } = await pool.query(
      `SELECT
         m.id                                                         AS match_id,
         m.created_at                                                 AS matched_at,

         -- Other user — identity
         other.id                                                     AS other_id,
         other.name                                                   AS other_name,
         other.profile_picture_url                                    AS other_photo,
         other.photos                                                 AS other_photos,
         other.bio                                                    AS other_bio,
         other.city                                                   AS other_city,
         other.birth_date                                             AS other_birth_date,
         other.gender                                                 AS other_gender,

         -- Other user — lifestyle & profile
         other.tags                                                   AS other_tags,
         other.relation_type                                          AS other_relation_type,
         other.height_cm                                              AS other_height_cm,
         other.languages                                              AS other_languages,
         other.astro_sign                                             AS other_astro_sign,
         other.education                                              AS other_education,
         other.job_title                                              AS other_job_title,
         other.company                                                AS other_company,
         other.family_plans                                           AS other_family_plans,
         other.communication_style                                    AS other_communication_style,
         other.love_language                                          AS other_love_language,
         other.pet                                                    AS other_pet,
         other.alcohol                                                AS other_alcohol,
         other.tobacco                                                AS other_tobacco,
         other.sport                                                  AS other_sport,
         other.evenings_type                                          AS other_evenings_type,
         other.weekends_type                                          AS other_weekends_type,
         other.favorite_song                                          AS other_favorite_song,
         other.social_media                                          AS other_social_media,

         -- Distance (NULL if either user has no coordinates)
         ${haversineSQL('$2', '$3', 'other')}                        AS other_dist_km,

         -- Last message (LATERAL gives us the single most-recent row cheaply)
         last_msg.content                                             AS last_message,
         last_msg.created_at                                          AS last_message_at,
         last_msg.sender_id                                           AS last_message_sender_id,

         -- Unread count: messages sent by the other user that we haven't read yet
         COALESCE(unread.cnt, 0)::INT                                 AS unread_count,

         -- Speed Date flag: TRUE if the match was created via a Speed Date like in the last 4h
         (EXISTS (
           SELECT 1 FROM likes l
           WHERE l.is_speed_date = TRUE
             AND ((l.liker_id = m.user1_id AND l.liked_id = m.user2_id)
               OR (l.liker_id = m.user2_id AND l.liked_id = m.user1_id))
         ) AND m.created_at > NOW() - INTERVAL '4 hours')             AS is_speed_date

       FROM matches m

       -- Resolve "other user" without branching in multiple joins
       JOIN users other
         ON other.id = CASE
              WHEN m.user1_id = $1 THEN m.user2_id
              ELSE m.user1_id
            END

       -- Last message via LATERAL (index-friendly, no full table scan)
       LEFT JOIN LATERAL (
         SELECT content, created_at, sender_id
         FROM messages
         WHERE match_id = m.id
         ORDER BY created_at DESC
         LIMIT 1
       ) last_msg ON TRUE

       -- Unread count via LATERAL
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS cnt
         FROM messages
         WHERE match_id  = m.id
           AND sender_id != $1
           AND read_at   IS NULL
       ) unread ON TRUE

       WHERE (m.user1_id = $1 OR m.user2_id = $1)
         AND m.is_active = TRUE
         AND ${notBlockedClause('$1', 'other')}

       ORDER BY COALESCE(last_msg.created_at, m.created_at) DESC`,
      [userId, myLat, myLng]
    );

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── GET /api/matches/:id ──────────────────────────────────────────────────────
// Returns a single match with the other user's full public profile.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/:id',
  [param('id').isUUID().withMessage('Match id must be a valid UUID')],
  validate,
  async (req, res, next) => {
    const userId  = req.user.id;
    const matchId = req.params.id;

    try {
      const { rows } = await pool.query(
        `SELECT
           m.id          AS match_id,
           m.created_at  AS matched_at,
           other.id                    AS other_id,
           other.name                  AS other_name,
           other.bio                   AS other_bio,
           other.profile_picture_url   AS other_photo,
           other.photos                AS other_photos,
           other.city                  AS other_city,
           other.birth_date            AS other_birth_date,
           other.tags                  AS other_tags,
           other.relation_type         AS other_relation_type,
           other.job_title             AS other_job_title,
           other.company               AS other_company
         FROM matches m
         JOIN users other
           ON other.id = CASE
                WHEN m.user1_id = $1 THEN m.user2_id
                ELSE m.user1_id
              END
         WHERE m.id = $2
           AND (m.user1_id = $1 OR m.user2_id = $1)
           AND m.is_active = TRUE`,
        [userId, matchId]
      );

      if (!rows.length) return res.status(404).json({ error: 'Match not found or access denied' });
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// ── DELETE /api/matches/:id ───────────────────────────────────────────────────
// Soft-deletes a match by setting is_active = FALSE.
// Only a member of the match (user1_id or user2_id) can unmatch.
// ─────────────────────────────────────────────────────────────────────────────
router.delete(
  '/:id',
  [param('id').isUUID().withMessage('Match id must be a valid UUID')],
  validate,
  async (req, res, next) => {
    try {
      const { rowCount, rows } = await pool.query(
        `UPDATE matches
         SET is_active = FALSE
         WHERE id = $1
           AND (user1_id = $2 OR user2_id = $2)
           AND is_active = TRUE
         RETURNING user1_id, user2_id`,
        [req.params.id, req.user.id]
      );

      if (rowCount === 0) return res.status(404).json({ error: 'Match not found or access denied' });

      const io = req.app.get('io');
      if (io) {
        const otherId = rows[0].user1_id === req.user.id ? rows[0].user2_id : rows[0].user1_id;
        io.to(`user:${otherId}`).emit('match_cancelled', { match_id: req.params.id });
      }

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
