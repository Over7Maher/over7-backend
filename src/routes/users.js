const express = require('express');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db/pool');
const auth = require('../middleware/auth');
const { calculateCompletude, completudeBreakdown } = require('../services/completude');
const { shouldBeInPool } = require('../services/poolGate');
const { handlePoolTransition } = require('../services/poolTransition');
const formatUser = require('../utils/formatUser');

const router = express.Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });
  next();
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
      // Idempotent: return existing user if firebase_uid already registered.
      // If the account is soft-deleted within the 30-day grace period, reactivate it.
      const existing = await pool.query(
        'SELECT * FROM users WHERE firebase_uid = $1',
        [firebase_uid]
      );

      if (existing.rows.length > 0) {
        const row = existing.rows[0];

        if (row.is_active) {
          return res.status(200).json(formatUser(row));
        }

        // Soft-deleted: reactivate if still within the 30-day window.
        const within30Days =
          row.deleted_at &&
          (Date.now() - new Date(row.deleted_at).getTime()) < 30 * 24 * 60 * 60 * 1000;

        if (within30Days) {
          const { rows: reactivated } = await pool.query(
            `UPDATE users
             SET is_active = TRUE, deleted_at = NULL
             WHERE id = $1
             RETURNING *`,
            [row.id]
          );
          console.log('[users] reactivate:', row.id);
          return res.status(200).json(formatUser(reactivated[0]));
        }

        // Grace period expired: hard-delete the stale row before INSERT.
        // All FKs pointing to users(id) have ON DELETE CASCADE, verified via
        // information_schema. This cascades into arena_votes, blocks, likes,
        // matches, messages, reports, speed_date_registrations, user_prompts.
        await pool.query('DELETE FROM users WHERE id = $1', [row.id]);
        console.log('[users] expired grace period, hard-delete:', row.id);
        // Falls through to INSERT below.
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

// ── GET /users/me/completude ──────────────────────────────────────────────────
// Server-authoritative completude grid: { pct, items: [{key,label,pts,done}] }.
// The frontend renders the detail screen as a pure consumer — no local recomputation,
// so the grid stays in sync with the server's calculateCompletude() automatically.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/me/completude', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::INT AS count FROM user_prompts WHERE user_id = $1`,
      [req.user.id]
    );
    const promptsCount = rows[0]?.count ?? 0;
    res.json(completudeBreakdown(req.user, promptsCount));
  } catch (err) {
    next(err);
  }
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
               AND m.is_active = TRUE
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

// ── PATCH /users/me/notification-preferences ─────────────────────────────────
// Body: { preferences: { match?: bool, message?: bool, speed_date?: bool, like?: bool } }
// Partial update: keys absent from the body keep their current value.
// Unknown keys or non-boolean values are silently dropped.
// ─────────────────────────────────────────────────────────────────────────────
const NOTIF_PREF_KEYS = ['match', 'message', 'speed_date', 'like'];

router.patch(
  '/me/notification-preferences',
  auth,
  async (req, res, next) => {
    const incoming = req.body?.preferences;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return res.status(400).json({ error: 'preferences object is required' });
    }

    const filtered = Object.fromEntries(
      Object.entries(incoming).filter(
        ([k, v]) => NOTIF_PREF_KEYS.includes(k) && typeof v === 'boolean'
      )
    );
    if (Object.keys(filtered).length === 0) {
      return res.status(400).json({ error: 'No valid preferences provided' });
    }

    try {
      const { rows } = await pool.query(
        `UPDATE users
            SET notification_preferences = notification_preferences || $1::jsonb
          WHERE id = $2
          RETURNING notification_preferences`,
        [JSON.stringify(filtered), req.user.id]
      );
      res.json({ preferences: rows[0].notification_preferences });
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /users/me/location ──────────────────────────────────────────────────
// Updates the user's position (rounded to 2 decimal places ≈ 1 km grid).
// is_in_pool is re-evaluated against the full pool gate conditions.
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
        `UPDATE users SET latitude = $1, longitude = $2 WHERE id = $3`,
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

    // Auto-initialize matching filters on first birth_date assignment.
    // Triggers only when the user has none of the three filters set yet,
    // preserving any manual override the user may have done later.
    const hasNoFilters =
      req.user.age_min      == null &&
      req.user.age_max      == null &&
      req.user.distance_max == null;

    if (updates.birth_date && hasNoFilters) {
      const birth = new Date(updates.birth_date);
      const today = new Date();
      let age = today.getFullYear() - birth.getFullYear();
      const m = today.getMonth() - birth.getMonth();
      if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;

      if (updates.age_min      === undefined) updates.age_min      = Math.max(18, age - 10);
      if (updates.age_max      === undefined) updates.age_max      = Math.min(70, age + 20);
      if (updates.distance_max === undefined) updates.distance_max = 50;

      console.log('[users] auto-init matching filters for', req.user.id,
                  'age=' + age,
                  'min=' + updates.age_min,
                  'max=' + updates.age_max,
                  'dist=' + updates.distance_max);
    }

    // Prompts count is needed for the "3 minimum prompts" item (+7 pts).
    const { rows: promptRows } = await pool.query(
      `SELECT COUNT(*)::INT AS count FROM user_prompts WHERE user_id = $1`,
      [req.user.id]
    );
    const promptsCount = promptRows[0]?.count ?? 0;

    // Merge incoming changes onto the current user to compute new completude_pct and pool eligibility.
    // Pass the freshly computed completude_pct to shouldBeInPool — otherwise crossing the 70% threshold
    // via PATCH wouldn't open the pool until the NEXT PATCH (latent two-step delay).
    const merged = { ...req.user, ...updates };
    updates.completude_pct = calculateCompletude(merged, promptsCount);
    const wasInPool   = req.user.is_in_pool === true;
    const newIsInPool = shouldBeInPool({ ...merged, completude_pct: updates.completude_pct });
    updates.is_in_pool = newIsInPool;

    const keys   = Object.keys(updates);
    const values = Object.values(updates);
    const set    = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');

    try {
      const { rows } = await pool.query(
        `UPDATE users SET ${set} WHERE id = $${keys.length + 1} RETURNING *`,
        [...values, req.user.id]
      );
      await handlePoolTransition({
        io:            req.app.get('io'),
        userId:        req.user.id,
        wasInPool,
        isInPool:      newIsInPool,
        completudePct: updates.completude_pct,
      });
      res.json(formatUser(rows[0]));
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /users/me/acknowledge-pool-unlock ────────────────────────────────────
// Called after the celebration modal is shown — resets the pending flag.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/me/acknowledge-pool-unlock', auth, async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE users SET pool_unlocked_pending = FALSE WHERE id = $1`,
      [req.user.id]
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ── POST /users/me/acknowledge-pool-exit ──────────────────────────────────────
// Called after the user dismisses the "you've left the pool" banner.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/me/acknowledge-pool-exit', auth, async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE users SET pool_exit_pending = FALSE WHERE id = $1`,
      [req.user.id]
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ── POST /users/me/acknowledge-arena-intro ────────────────────────────────────
// Called after the Arena onboarding modal is shown on first access.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/me/acknowledge-arena-intro', auth, async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE users SET arena_intro_seen = TRUE WHERE id = $1`,
      [req.user.id]
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ── DELETE /users/me ──────────────────────────────────────────────────────────
// RGPD-compliant soft delete. The auth middleware already filters out
// is_active = FALSE rows, so the account becomes inaccessible immediately.
// A 30-day grace period allows reactivation via POST /users/register before
// a downstream cron permanently purges the row.
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/me', auth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE users
       SET is_active = FALSE, deleted_at = NOW()
       WHERE id = $1 AND is_active = TRUE
       RETURNING id`,
      [req.user.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User not found or already deleted' });
    }
    console.log('[users] soft delete:', req.user.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
