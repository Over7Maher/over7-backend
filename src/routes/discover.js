const express = require('express');
const { query, validationResult } = require('express-validator');
const pool = require('../db/pool');
const auth = require('../middleware/auth');
const haversineSQL = require('../db/haversine');

const router = express.Router();

router.use(auth);

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });
  next();
}

// ── GET /api/discover/profiles ────────────────────────────────────────────────
// Returns a scored, filtered list of profiles to swipe.
//
// Scoring formula (higher = shown first):
//   avg_rating   × 2.0   — Arena community rating (neutral default: 5 if null)
//   tags overlap × 3.0   — +3 per shared tag with current user
//   relation_type        — +5 if profile matches user's preferred relation type
//   completude_pct × 0.1 — +0–10 bonus for profile completeness
//
// Filters applied:
//   - is_in_pool = TRUE, is_active = TRUE
//   - gender matches user's `seeking` preference (skipped if null / 'all')
//   - age within user's [age_min, age_max] range (skipped if null)
//   - profiles already liked by the user are excluded
//   - profiles with an existing match are excluded
//   - profiles without lat/lng are excluded
//   - distance <= me.distance_max km (or unrestricted if distance_max is null)
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/profiles',
  [
    query('limit')
      .optional()
      .isInt({ min: 1, max: 50 })
      .withMessage('limit must be an integer between 1 and 50')
      .toInt(),
    query('offset')
      .optional()
      .isInt({ min: 0 })
      .withMessage('offset must be a non-negative integer')
      .toInt(),
  ],
  validate,
  async (req, res, next) => {
    const me = req.user;

    if (me.latitude == null || me.longitude == null) {
      return res.status(400).json({ error: 'Location required to discover profiles' });
    }

    const limit  = req.query.limit  ?? 10;
    const offset = req.query.offset ?? 0;

    const genderFilter = (me.seeking === 'male' || me.seeking === 'female') ? me.seeking : null;
    const ageMin       = me.age_min       ?? null;
    const ageMax       = me.age_max       ?? null;
    const myTags       = me.tags          ?? [];
    const myRelType    = me.relation_type ?? null;
    const distMax      = me.distance_max  ?? null;

    try {
      const { rows } = await pool.query(
        `WITH candidates AS (
           SELECT
             u.id,
             u.name,
             u.birth_date,
             u.city,
             u.bio,
             u.profile_picture_url,
             u.photos,
             u.tags,
             u.relation_type,
             u.family_plans,
             u.communication_style,
             u.love_language,
             u.gender,
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
             u.avg_rating,
             u.completude_pct,
             ${haversineSQL('$9', '$10', 'u')} AS dist_km,
             (
               COALESCE(u.avg_rating, 5) * 2.0
               + COALESCE(
                   array_length(
                     ARRAY(
                       SELECT UNNEST(COALESCE(u.tags, '{}'))
                       INTERSECT
                       SELECT UNNEST($4::TEXT[])
                     ),
                     1
                   ),
                   0
                 ) * 3.0
               + CASE WHEN u.relation_type IS NOT NULL
                      AND u.relation_type = $5
                      THEN 5.0 ELSE 0.0 END
               + u.completude_pct * 0.1
             ) AS score
           FROM users u
           WHERE u.id        != $1
             AND u.is_active  = TRUE
             AND u.is_in_pool = TRUE
             AND u.latitude  IS NOT NULL
             AND u.longitude IS NOT NULL
             AND ($6::TEXT IS NULL OR u.gender = $6)
             AND ($7::INT  IS NULL OR DATE_PART('year', AGE(u.birth_date)) >= $7)
             AND ($8::INT  IS NULL OR DATE_PART('year', AGE(u.birth_date)) <= $8)
             AND NOT EXISTS (
               SELECT 1 FROM likes l
               WHERE l.liker_id = $1 AND l.liked_id = u.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM matches m
               WHERE m.user1_id = LEAST($1::uuid, u.id)
                 AND m.user2_id = GREATEST($1::uuid, u.id)
             )
         )
         SELECT * FROM candidates
         WHERE dist_km <= COALESCE($11::INT, 999999)
         ORDER BY score DESC, avg_rating DESC NULLS LAST
         LIMIT  $2
         OFFSET $3`,
        [me.id, limit, offset, myTags, myRelType, genderFilter, ageMin, ageMax,
         me.latitude, me.longitude, distMax]
      );

      res.json({
        profiles:         rows,
        count:            rows.length,
        offset,
        no_more_profiles: rows.length < limit,
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
