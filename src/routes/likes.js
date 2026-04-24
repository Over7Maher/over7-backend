const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const auth = require('../middleware/auth');
const haversineSQL = require('../db/haversine');
const { notBlockedClause } = require('../db/blocks');
const { sendPushToUser } = require('../services/push');
const { getCurrentSlot } = require('../utils/slots');

const router = express.Router();

router.use(auth);

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });
  next();
}

function computeNextMidnightBrussels() {
  const now = new Date();
  const brusselsDate = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Brussels' }));
  const nextMidnight = new Date(brusselsDate);
  nextMidnight.setDate(nextMidnight.getDate() + 1);
  nextMidnight.setHours(0, 0, 0, 0);
  return nextMidnight.toISOString();
}

// ── POST /api/likes ───────────────────────────────────────────────────────────
// Like a user. If the like is reciprocal, creates a match automatically.
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/',
  [
    body('liked_id').isUUID().withMessage('liked_id must be a valid UUID'),
    body('is_speed_date').optional().isBoolean().withMessage('is_speed_date must be a boolean'),
  ],
  validate,
  async (req, res, next) => {
    const likerId = req.user.id;
    const likedId = req.body.liked_id;

    if (likerId === likedId) {
      return res.status(400).json({ error: 'You cannot like yourself' });
    }

    try {
      const io = req.app.get('io');
      const isSpeedDate = req.body.is_speed_date === true;

      // Preserve an existing is_speed_date=TRUE if a subsequent normal like
      // arrives (e.g. outside the slot window) — OR with the incoming value.
      const insertLike = await pool.query(
        `INSERT INTO likes (liker_id, liked_id, is_speed_date)
         VALUES ($1, $2, $3)
         ON CONFLICT (liker_id, liked_id) DO UPDATE
           SET is_speed_date = likes.is_speed_date OR EXCLUDED.is_speed_date
         RETURNING id, is_speed_date, (xmax = 0) AS is_new`,
        [likerId, likedId, isSpeedDate]
      );

      const likeRow = insertLike.rows[0];
      const likeId  = likeRow.id;
      const isNew   = likeRow.is_new === true;
      const status  = isNew ? 201 : 200;

      // Check for reciprocal like even if the like already existed —
      // the match may not have been created on the original insert.
      const reciprocal = await pool.query(
        `SELECT 1 FROM likes WHERE liker_id = $1 AND liked_id = $2`,
        [likedId, likerId]
      );

      if (reciprocal.rowCount === 0) {
        if (io && isNew) {
          io.to(`user:${likedId}`).emit('new_like', {
            liker_id:      likerId,
            liker_name:    req.user.name,
            is_speed_date: likeRow.is_speed_date === true,
          });
        }
        return res.status(status).json({
          like_id:       likeId,
          is_match:      false,
          is_speed_date: likeRow.is_speed_date === true,
        });
      }

      // Reciprocal like exists → create or reactivate match (user1_id < user2_id enforced by schema)
      // If this like is a Speed Date like, capture the current slot so the chat can display it.
      const currentSlot = likeRow.is_speed_date === true ? getCurrentSlot() : null;
      const slotType = currentSlot?.slot_type ?? null;
      const slotDate = currentSlot?.slot_date ?? null;

      const insertMatch = await pool.query(
        `INSERT INTO matches (user1_id, user2_id, speed_date_slot_type, speed_date_slot_date)
         VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid), $3, $4)
         ON CONFLICT (user1_id, user2_id) DO UPDATE
           SET is_active  = TRUE,
               created_at = CASE WHEN matches.is_active = FALSE THEN NOW() ELSE matches.created_at END,
               speed_date_slot_type = COALESCE(EXCLUDED.speed_date_slot_type, matches.speed_date_slot_type),
               speed_date_slot_date = COALESCE(EXCLUDED.speed_date_slot_date, matches.speed_date_slot_date)
         RETURNING id, (xmax = 0) AS is_new`,
        [likerId, likedId, slotType, slotDate]
      );

      const matchId = insertMatch.rows[0]?.id ?? null;
      const matchIsNew = insertMatch.rows[0]?.is_new === true;

      // Speed Date match → insert a one-time system message inviting them to pick a spot.
      // Only on NEW matches (not on reactivation of an old match), and only if the slot was captured.
      if (matchId && matchIsNew && currentSlot) {
        await pool.query(
          `INSERT INTO messages (match_id, sender_id, content, type)
           VALUES ($1, NULL, $2, 'system')`,
          [matchId, '⚡ Vous avez matché pendant un Speed Date. Proposez un lieu !']
        );
      }

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

      return res.status(status).json({
        like_id:       likeId,
        is_match:      true,
        match_id:      matchId,
        is_speed_date: likeRow.is_speed_date === true,
      });
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
         u.id, u.name, u.profile_picture_url, u.photos, u.city, u.birth_date,
         u.bio, u.tags, u.relation_type, u.height_cm, u.languages,
         u.astro_sign, u.education, u.job_title, u.company,
         u.family_plans, u.communication_style, u.love_language,
         u.pet, u.alcohol, u.tobacco, u.sport,
         u.evenings_type, u.weekends_type, u.favorite_song, u.social_media, u.gender,
         l.is_super,
         l.is_speed_date,
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
             AND m.is_active = TRUE
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

// ── GET /api/likes/can-super-like ─────────────────────────────────────────────
// Returns whether the current user has a super like available today
// (Europe/Brussels calendar day). If not, returns next_available_at (next midnight).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/can-super-like', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         CASE
           WHEN last_super_like_at IS NULL THEN TRUE
           WHEN (last_super_like_at AT TIME ZONE 'Europe/Brussels')::date
              < (NOW()              AT TIME ZONE 'Europe/Brussels')::date THEN TRUE
           ELSE FALSE
         END AS can_super_like
       FROM users WHERE id = $1`,
      [req.user.id]
    );

    const canSuper = rows[0]?.can_super_like === true;
    res.json({
      can_super_like:    canSuper,
      next_available_at: canSuper ? null : computeNextMidnightBrussels(),
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/likes/super ─────────────────────────────────────────────────────
// Super-like a user. Quota: 1 per Europe/Brussels calendar day.
// Reciprocal super-like creates (or reactivates) a match, same as a normal like.
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/super',
  [
    body('liked_id').isUUID().withMessage('liked_id must be a valid UUID'),
    body('is_speed_date').optional().isBoolean().withMessage('is_speed_date must be a boolean'),
  ],
  validate,
  async (req, res, next) => {
    const likerId = req.user.id;
    const likedId = req.body.liked_id;

    if (likerId === likedId) {
      return res.status(400).json({ error: 'You cannot super-like yourself' });
    }

    try {
      const io = req.app.get('io');

      // 1 — Quota check: has the user already super-liked today (Europe/Brussels)?
      const { rows: quotaRows } = await pool.query(
        `SELECT
           last_super_like_at IS NOT NULL
           AND (last_super_like_at AT TIME ZONE 'Europe/Brussels')::date
             = (NOW()              AT TIME ZONE 'Europe/Brussels')::date AS used_today
         FROM users WHERE id = $1`,
        [likerId]
      );
      if (quotaRows[0]?.used_today === true) {
        return res.status(429).json({
          error:             'Super Like quota exceeded for today',
          next_available_at: computeNextMidnightBrussels(),
        });
      }

      // 2 — Insert (or upgrade existing like to super).
      // is_speed_date is sticky: OR'd with any prior value, never downgraded.
      const isSpeedDate = req.body.is_speed_date === true;
      const insertLike = await pool.query(
        `INSERT INTO likes (liker_id, liked_id, is_super, is_speed_date)
         VALUES ($1, $2, TRUE, $3)
         ON CONFLICT (liker_id, liked_id) DO UPDATE
           SET is_super      = TRUE,
               is_speed_date = likes.is_speed_date OR EXCLUDED.is_speed_date
         RETURNING id, is_speed_date`,
        [likerId, likedId, isSpeedDate]
      );
      const likeRow = insertLike.rows[0];
      const likeId  = likeRow.id;

      // 3 — Consume the daily quota
      await pool.query(
        `UPDATE users SET last_super_like_at = NOW() WHERE id = $1`,
        [likerId]
      );

      // 4 — Reciprocal like → create or reactivate match
      const reciprocal = await pool.query(
        `SELECT 1 FROM likes WHERE liker_id = $1 AND liked_id = $2`,
        [likedId, likerId]
      );

      if (reciprocal.rowCount === 0) {
        if (io) {
          io.to(`user:${likedId}`).emit('new_like', {
            liker_id:      likerId,
            liker_name:    req.user.name,
            is_super:      true,
            is_speed_date: likeRow.is_speed_date === true,
          });
        }
        return res.status(201).json({
          like_id:       likeId,
          is_match:      false,
          is_super:      true,
          is_speed_date: likeRow.is_speed_date === true,
        });
      }

      // Capture the current slot if this super like is also a Speed Date like.
      const currentSlot = likeRow.is_speed_date === true ? getCurrentSlot() : null;
      const slotType = currentSlot?.slot_type ?? null;
      const slotDate = currentSlot?.slot_date ?? null;

      const insertMatch = await pool.query(
        `INSERT INTO matches (user1_id, user2_id, speed_date_slot_type, speed_date_slot_date)
         VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid), $3, $4)
         ON CONFLICT (user1_id, user2_id) DO UPDATE
           SET is_active  = TRUE,
               created_at = CASE WHEN matches.is_active = FALSE THEN NOW() ELSE matches.created_at END,
               speed_date_slot_type = COALESCE(EXCLUDED.speed_date_slot_type, matches.speed_date_slot_type),
               speed_date_slot_date = COALESCE(EXCLUDED.speed_date_slot_date, matches.speed_date_slot_date)
         RETURNING id, (xmax = 0) AS is_new`,
        [likerId, likedId, slotType, slotDate]
      );
      const matchId = insertMatch.rows[0]?.id ?? null;
      const matchIsNew = insertMatch.rows[0]?.is_new === true;

      // Speed Date match → insert a one-time system message inviting them to pick a spot.
      if (matchId && matchIsNew && currentSlot) {
        await pool.query(
          `INSERT INTO messages (match_id, sender_id, content, type)
           VALUES ($1, NULL, $2, 'system')`,
          [matchId, '⚡ Vous avez matché pendant un Speed Date. Proposez un lieu !']
        );
      }

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

      return res.status(201).json({
        like_id:       likeId,
        is_match:      true,
        match_id:      matchId,
        is_super:      true,
        is_speed_date: likeRow.is_speed_date === true,
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
