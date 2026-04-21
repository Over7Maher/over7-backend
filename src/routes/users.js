const express = require('express');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db/pool');
const auth = require('../middleware/auth');
const { calculateCompletude } = require('../services/completude');

const router = express.Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });
  next();
}

// Columns exposed on profile responses (never return raw rows)
function formatUser(row) {
  return {
    id:                  row.id,
    email:               row.email,
    name:                row.name,
    birth_date:          row.birth_date,
    city:                row.city,
    bio:                 row.bio,
    profile_picture_url: row.profile_picture_url,
    photos:              row.photos,
    tags:                row.tags,

    // Dating preferences
    relation_type:       row.relation_type,
    family_plans:        row.family_plans,
    communication_style: row.communication_style,
    love_language:       row.love_language,

    // Identity & lifestyle
    gender:              row.gender,
    height_cm:           row.height_cm,
    languages:           row.languages,
    astro_sign:          row.astro_sign,
    education:           row.education,
    job_title:           row.job_title,
    company:             row.company,
    pet:                 row.pet,
    alcohol:             row.alcohol,
    tobacco:             row.tobacco,
    sport:               row.sport,
    social_media:        row.social_media,
    evenings_type:       row.evenings_type,
    weekends_type:       row.weekends_type,
    favorite_song:       row.favorite_song,

    // Matching preferences
    seeking:             row.seeking,
    age_min:             row.age_min,
    age_max:             row.age_max,
    distance_max:        row.distance_max,

    // Scores & pool
    completude_pct:      row.completude_pct,
    arena_votes_given:   row.arena_votes_given,
    is_in_pool:          row.is_in_pool,
    avg_rating:          row.avg_rating,

    created_at:          row.created_at,
  };
}

// ── POST /users/register ──────────────────────────────────────────────────────
// Called once after Firebase sign-up, before onboarding.
// Body: { firebase_uid, email, name, birth_date }
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/register',
  [
    body('firebase_uid').notEmpty().withMessage('firebase_uid is required'),
    body('email').optional({ nullable: true }).isEmail().withMessage('Invalid email format'),
    body('name').optional({ nullable: true }).trim(),
    body('birth_date').optional({ nullable: true }).isISO8601().withMessage('birth_date must be YYYY-MM-DD'),
    body('seeking').optional({ nullable: true }).isIn(['male', 'female', 'all']).withMessage('seeking must be male, female or all'),
    body('age_min').optional({ nullable: true }).isInt({ min: 18, max: 70 }).withMessage('age_min must be 18–70'),
    body('age_max').optional({ nullable: true }).isInt({ min: 18, max: 70 }).withMessage('age_max must be 18–70'),
    body('distance_max').optional({ nullable: true }).isInt({ min: 1, max: 500 }).withMessage('distance_max must be 1–500'),
  ],
  validate,
  async (req, res, next) => {
    const { firebase_uid } = req.body;
    const email        = req.body.email        || `${firebase_uid}@anonymous.over7.app`;
    const name         = req.body.name         || null;
    const birth_date   = req.body.birth_date   || null;
    const seeking      = req.body.seeking      || null;
    const age_min      = req.body.age_min      ?? null;
    const age_max      = req.body.age_max      ?? null;
    const distance_max = req.body.distance_max ?? null;

    try {
      // Idempotent: return existing user if firebase_uid already registered
      const existing = await pool.query(
        'SELECT * FROM users WHERE firebase_uid = $1',
        [firebase_uid]
      );
      if (existing.rows.length > 0) {
        return res.status(200).json(formatUser(existing.rows[0]));
      }

      const id = uuidv4();
      const { rows } = await pool.query(
        `INSERT INTO users (id, firebase_uid, email, name, birth_date, seeking, age_min, age_max, distance_max)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [id, firebase_uid, email, name, birth_date, seeking, age_min, age_max, distance_max]
      );

      res.status(201).json(formatUser(rows[0]));
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Email already in use' });
      }
      next(err);
    }
  }
);

// ── GET /users/me ─────────────────────────────────────────────────────────────
router.get('/me', auth, (req, res) => {
  res.json(formatUser(req.user));
});

// ── GET /users/me/counts ──────────────────────────────────────────────────────
// Badge counters for the TabBar: unread likes and unread matches.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/me/counts', auth, async (req, res, next) => {
  const userId = req.user.id;

  try {
    const [likesResult, matchesResult] = await Promise.all([
      pool.query(
        `WITH me AS (
           SELECT last_seen_likes_at FROM users WHERE id = $1
         )
         SELECT COUNT(*)::INT AS cnt
         FROM likes l, me
         WHERE l.liked_id = $1
           AND l.created_at > me.last_seen_likes_at
           AND NOT EXISTS (
             SELECT 1 FROM matches m
             WHERE m.user1_id = LEAST($1::uuid, l.liker_id)
               AND m.user2_id = GREATEST($1::uuid, l.liker_id)
           )`,
        [userId]
      ),
      pool.query(
        `WITH me AS (
           SELECT last_seen_matches_at FROM users WHERE id = $1
         )
         SELECT COUNT(DISTINCT m.id)::INT AS cnt
         FROM matches m, me
         WHERE (m.user1_id = $1 OR m.user2_id = $1)
           AND m.is_active = TRUE
           AND (
             m.created_at > me.last_seen_matches_at
             OR EXISTS (
               SELECT 1 FROM messages msg
               WHERE msg.match_id  = m.id
                 AND msg.sender_id != $1
                 AND msg.read_at   IS NULL
             )
           )`,
        [userId]
      ),
    ]);

    res.json({
      likes_received:  likesResult.rows[0]?.cnt  ?? 0,
      unread_matches:  matchesResult.rows[0]?.cnt ?? 0,
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /users/me/seen-matches ───────────────────────────────────────────────
// Called when the user opens the Matches tab — resets the new-match badge.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/me/seen-matches', auth, async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE users SET last_seen_matches_at = NOW() WHERE id = $1`,
      [req.user.id]
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ── POST /users/me/seen-likes ─────────────────────────────────────────────────
// Called when the user opens the Likes tab — resets the new-likes badge.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/me/seen-likes', auth, async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE users SET last_seen_likes_at = NOW() WHERE id = $1`,
      [req.user.id]
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ── PATCH /users/me/push-token ────────────────────────────────────────────────
// Registers or updates the Expo push token for the current user's device.
// ─────────────────────────────────────────────────────────────────────────────
router.patch(
  '/me/push-token',
  auth,
  [
    body('token')
      .isString().withMessage('token must be a string')
      .trim()
      .notEmpty().withMessage('token cannot be empty')
      .isLength({ max: 200 }).withMessage('token exceeds 200 characters'),
  ],
  validate,
  async (req, res, next) => {
    try {
      await pool.query(
        'UPDATE users SET push_token = $1 WHERE id = $2',
        [req.body.token.trim(), req.user.id]
      );
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /users/me/location ──────────────────────────────────────────────────
// Updates the user's position (rounded to 2 decimal places ≈ 1 km grid).
// Also flips is_in_pool = TRUE so the profile becomes discoverable.
// ─────────────────────────────────────────────────────────────────────────────
router.patch(
  '/me/location',
  auth,
  [
    body('latitude')
      .notEmpty().withMessage('latitude is required')
      .isFloat({ min: -90,  max: 90  }).withMessage('latitude must be between -90 and 90'),
    body('longitude')
      .notEmpty().withMessage('longitude is required')
      .isFloat({ min: -180, max: 180 }).withMessage('longitude must be between -180 and 180'),
  ],
  validate,
  async (req, res, next) => {
    const lat = Math.round(req.body.latitude  * 100) / 100;
    const lng = Math.round(req.body.longitude * 100) / 100;

    try {
      await pool.query(
        `UPDATE users SET latitude = $1, longitude = $2, is_in_pool = TRUE WHERE id = $3`,
        [lat, lng, req.user.id]
      );
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /users/me ───────────────────────────────────────────────────────────
// Accepted fields: all profile columns.
// completude_pct is recalculated automatically — never accepted from client.
// ─────────────────────────────────────────────────────────────────────────────
const PATCHABLE = [
  // Identity
  'name', 'birth_date', 'city', 'bio', 'profile_picture_url', 'photos',
  'tags', 'gender',
  // Dating preferences
  'relation_type', 'family_plans', 'communication_style', 'love_language',
  // Physical & background
  'height_cm', 'languages', 'astro_sign', 'education',
  // Work
  'job_title', 'company',
  // Lifestyle
  'pet', 'alcohol', 'tobacco', 'sport', 'social_media',
  'evenings_type', 'weekends_type', 'favorite_song',
  // Device
  'push_token',
  // Matching preferences
  'seeking', 'age_min', 'age_max', 'distance_max',
];

router.patch(
  '/me',
  auth,
  [
    body('birth_date').optional().isISO8601().withMessage('birth_date must be YYYY-MM-DD'),
    body('height_cm').optional().isInt({ min: 100, max: 250 }).withMessage('height_cm must be 100–250'),
    body('tags').optional().isArray().withMessage('tags must be an array'),
    body('photos').optional().isArray().withMessage('photos must be an array'),
    body('languages').optional().isArray().withMessage('languages must be an array'),
    body('seeking').optional({ nullable: true }).isIn(['male', 'female', 'all']).withMessage('seeking must be male, female or all'),
    body('age_min').optional({ nullable: true }).isInt({ min: 18, max: 70 }).withMessage('age_min must be 18–70'),
    body('age_max').optional({ nullable: true }).isInt({ min: 18, max: 70 }).withMessage('age_max must be 18–70'),
    body('distance_max').optional({ nullable: true }).isInt({ min: 1, max: 500 }).withMessage('distance_max must be 1–500'),
  ],
  validate,
  async (req, res, next) => {
    const updates = {};
    for (const key of PATCHABLE) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields provided' });
    }

    // Merge incoming changes onto the current user to compute new completude_pct
    const merged = { ...req.user, ...updates };
    updates.completude_pct = calculateCompletude(merged);

    const keys   = Object.keys(updates);
    const values = Object.values(updates);
    const set    = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');

    try {
      const { rows } = await pool.query(
        `UPDATE users SET ${set} WHERE id = $${keys.length + 1} RETURNING *`,
        [...values, req.user.id]
      );
      res.json(formatUser(rows[0]));
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
