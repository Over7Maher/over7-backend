const express = require('express');
const { query, validationResult } = require('express-validator');
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

// ── GET /api/discover/profiles ────────────────────────────────────────────────
// Returns a scored, filtered list of profiles to swipe.
//
// Scoring formula (higher = shown first):
//   avg_rating   × 2.0   — Arena community rating (neutral default: 5 if null)
//   tags overlap × 3.0   — +3 per shared tag with current user
//   relation_type        — +5 if profile matches user's preferred relation type
//   completude_pct × 0.1 — +0–10 bonus for profile completeness
//
// Base filters (always applied):
//   - is_in_pool = TRUE, is_active = TRUE
//   - self / blocks / already liked / active matches excluded
//   - profiles without lat/lng excluded
//   - reciprocal seeking (candidate must accept user's gender)
//
// Optional query-param filters (each is applied only if provided):
//   gender, age_min, age_max, distance_max, height_min,
//   relation_type, family_plans, pet, alcohol, tobacco, sport,
//   evenings_type, weekends_type, communication_style, love_language,
//   education, city (substring ILIKE), tags (comma-separated, intersection),
//   languages (comma-separated, intersection).
// Missing query params fall back to the user's own preferences for
// gender/age_min/age_max/distance_max.
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

    // Query-param overrides fall back to the user's stored preferences
    const seekingSource = req.query.gender || me.seeking;
    const genderFilter  = (seekingSource === 'male' || seekingSource === 'female') ? seekingSource : null;
    const ageMin        = req.query.age_min      ? parseInt(req.query.age_min, 10)      : (me.age_min      ?? null);
    const ageMax        = req.query.age_max      ? parseInt(req.query.age_max, 10)      : (me.age_max      ?? null);
    const distMax       = req.query.distance_max ? parseInt(req.query.distance_max, 10) : (me.distance_max ?? null);

    // Scoring inputs — always taken from the user's own profile
    const myTags    = me.tags          ?? [];
    const myRelType = me.relation_type ?? null;
    const myLat     = me.latitude  !== null ? parseFloat(me.latitude)  : null;
    const myLng     = me.longitude !== null ? parseFloat(me.longitude) : null;

    // New optional query-param filters
    const heightMin          = req.query.height_min ? parseInt(req.query.height_min, 10) : null;
    const relationType       = req.query.relation_type       || null;
    const familyPlans        = req.query.family_plans        || null;
    const pet                = req.query.pet                 || null;
    const alcohol            = req.query.alcohol             || null;
    const tobacco            = req.query.tobacco             || null;
    const sport              = req.query.sport               || null;
    const eveningsType       = req.query.evenings_type       || null;
    const weekendsType       = req.query.weekends_type       || null;
    const communicationStyle = req.query.communication_style || null;
    const loveLanguage       = req.query.love_language       || null;
    const education          = req.query.education           || null;
    const city               = req.query.city                || null;
    const tagsFilter         = req.query.tags      ? req.query.tags.split(',').map(s => s.trim()).filter(Boolean)      : null;
    const languagesFilter    = req.query.languages ? req.query.languages.split(',').map(s => s.trim()).filter(Boolean) : null;

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
             u.social_media,
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
             AND ${notBlockedClause('$1', 'u')}
             AND u.latitude  IS NOT NULL
             AND u.longitude IS NOT NULL
             AND ($6::TEXT IS NULL OR u.gender = $6)
             AND (u.seeking IS NULL OR u.seeking = 'all' OR u.seeking = $12::TEXT)
             AND ($7::INT  IS NULL OR DATE_PART('year', AGE(u.birth_date)) >= $7)
             AND ($8::INT  IS NULL OR DATE_PART('year', AGE(u.birth_date)) <= $8)
             AND ($13::INT    IS NULL OR u.height_cm           >= $13)
             AND ($14::TEXT   IS NULL OR u.relation_type        = $14)
             AND ($15::TEXT   IS NULL OR u.family_plans         = $15)
             AND ($16::TEXT   IS NULL OR u.pet                  = $16)
             AND ($17::TEXT   IS NULL OR u.alcohol              = $17)
             AND ($18::TEXT   IS NULL OR u.tobacco              = $18)
             AND ($19::TEXT   IS NULL OR u.sport                = $19)
             AND ($20::TEXT   IS NULL OR u.evenings_type        = $20)
             AND ($21::TEXT   IS NULL OR u.weekends_type        = $21)
             AND ($22::TEXT   IS NULL OR u.communication_style  = $22)
             AND ($23::TEXT   IS NULL OR u.love_language        = $23)
             AND ($24::TEXT   IS NULL OR u.education            = $24)
             AND ($25::TEXT   IS NULL OR u.city ILIKE '%' || $25 || '%')
             AND ($26::TEXT[] IS NULL OR u.tags      && $26::TEXT[])
             AND ($27::TEXT[] IS NULL OR u.languages && $27::TEXT[])
             AND NOT EXISTS (
               SELECT 1 FROM likes l
               WHERE l.liker_id = $1 AND l.liked_id = u.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM matches m
               WHERE m.user1_id = LEAST($1::uuid, u.id)
                 AND m.user2_id = GREATEST($1::uuid, u.id)
                 AND m.is_active = TRUE
             )
         )
         SELECT * FROM candidates
         WHERE dist_km <= COALESCE($11::INT, 999999)
         ORDER BY score DESC, avg_rating DESC NULLS LAST
         LIMIT  $2
         OFFSET $3`,
        [
          me.id, limit, offset, myTags, myRelType, genderFilter, ageMin, ageMax,
          myLat, myLng, distMax, me.gender ?? null,
          heightMin, relationType, familyPlans, pet, alcohol, tobacco, sport,
          eveningsType, weekendsType, communicationStyle, loveLanguage,
          education, city, tagsFilter, languagesFilter,
        ]
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
