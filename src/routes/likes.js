const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const auth = require('../middleware/auth');
const haversineSQL = require('../db/haversine');
const { notBlockedClause } = require('../db/blocks');
const { sendPushToUser } = require('../services/push');
const { todayBrussels, brusselsHour } = require('../utils/slots');

const router = express.Router();

router.use(auth);

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });
  next();
}

// Finds the Speed Date slot (if any) that both users are registered to TODAY in
// Europe/Brussels. When both users share afternoon AND evening:
//   - before 18h → returns afternoon (the upcoming/ongoing one)
//   - 18h-22h59  → returns evening (afternoon is dead, evening is upcoming/ongoing)
//   - 23h+       → returns afternoon (fallback, both slots are dead anyway — the slot will
//                  be used as historical context only and slot_alive will resolve to FALSE)
// Returns { slot_type, slot_date } or null if no common registration today.
async function getCommonSlotToday(userAId, userBId) {
  const slotDate = todayBrussels();

  const { rows } = await pool.query(
    `SELECT slot_type
     FROM speed_date_registrations
     WHERE user_id = ANY($1::uuid[])
       AND slot_date = $2
       AND cancelled_at IS NULL
     GROUP BY slot_type
     HAVING COUNT(DISTINCT user_id) = 2`,
    [[userAId, userBId], slotDate]
  );

  if (rows.length === 0) return null;

  const slots = rows.map(r => r.slot_type);
  const hasAfternoon = slots.includes('afternoon');
  const hasEvening   = slots.includes('evening');
  const hour = brusselsHour();

  if (hasAfternoon && hasEvening) {
    // Both shared — prefer the upcoming/live one based on current Brussels hour.
    if (hour < 18) return { slot_type: 'afternoon', slot_date: slotDate };
    if (hour < 23) return { slot_type: 'evening',   slot_date: slotDate };
    return { slot_type: 'afternoon', slot_date: slotDate }; // rare edge case (23h+)
  }
  if (hasAfternoon) return { slot_type: 'afternoon', slot_date: slotDate };
  if (hasEvening)   return { slot_type: 'evening',   slot_date: slotDate };
  return null;
}

// Returns the end-of-slot label for a Speed Date slot type ("18h00", "23h00", or "").
function slotEndLabel(slotType) {
  if (slotType === 'afternoon') return '18h00';
  if (slotType === 'evening')   return '23h00';
  return '';
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

      // If this is a Speed Date like, capture the common slot shared by the two users today.
      const likeSlot = isSpeedDate ? await getCommonSlotToday(likerId, likedId) : null;
      const likeSlotType = likeSlot?.slot_type ?? null;
      const likeSlotDate = likeSlot?.slot_date ?? null;

      // Preserve an existing is_speed_date=TRUE if a subsequent normal like
      // arrives (e.g. outside the slot window) — OR with the incoming value.
      const insertLike = await pool.query(
        `INSERT INTO likes (liker_id, liked_id, is_speed_date, speed_date_slot_type, speed_date_slot_date)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (liker_id, liked_id) DO UPDATE
           SET is_speed_date = likes.is_speed_date OR EXCLUDED.is_speed_date,
               speed_date_slot_type = COALESCE(EXCLUDED.speed_date_slot_type, likes.speed_date_slot_type),
               speed_date_slot_date = COALESCE(EXCLUDED.speed_date_slot_date, likes.speed_date_slot_date)
         RETURNING id, is_speed_date, (xmax = 0) AS is_new`,
        [likerId, likedId, isSpeedDate, likeSlotType, likeSlotDate]
      );

      const likeRow = insertLike.rows[0];
      const likeId  = likeRow.id;
      const isNew   = likeRow.is_new === true;
      const status  = isNew ? 201 : 200;

      // Check for reciprocal like even if the like already existed —
      // the match may not have been created on the original insert.
      // We also fetch is_speed_date so we know if either side of the match came from Speed Date.
      const reciprocal = await pool.query(
        `SELECT is_speed_date FROM likes WHERE liker_id = $1 AND liked_id = $2`,
        [likedId, likerId]
      );

      if (reciprocal.rowCount === 0) {
        if (io && isNew) {
          io.to(`user:${likedId}`).emit('new_like', {
            liker_id:      likerId,
            liker_name:    req.user.name,
            is_speed_date: likeRow.is_speed_date === true,
          });
          sendPushToUser(
            likedId,
            "Quelqu'un t'a aimé(e) ✨",
            "Découvre qui c'est",
            { type: 'new_like' },
            'like'
          );
        }
        return res.status(status).json({
          like_id:       likeId,
          is_match:      false,
          is_speed_date: likeRow.is_speed_date === true,
        });
      }

      // Reciprocal like exists → create or reactivate match (user1_id < user2_id enforced by schema)
      // If EITHER like is a Speed Date like, capture the common slot shared by the two users today.
      // Falls back to NULL if the two users don't share an active slot today.
      const reciprocalIsSpeedDate = reciprocal.rows[0]?.is_speed_date === true;
      const eitherIsSpeedDate = likeRow.is_speed_date === true || reciprocalIsSpeedDate;
      const matchSlot = eitherIsSpeedDate ? await getCommonSlotToday(likerId, likedId) : null;
      const slotType = matchSlot?.slot_type ?? null;
      const slotDate = matchSlot?.slot_date ?? null;

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

        // Enriched push for Speed Date matches (slotType captured above is non-null only when alive).
        const isSpeedDateAlive = slotType !== null;
        const pushTitle = isSpeedDateAlive
          ? (name) => `⚡ Match Speed Date avec ${name} !`
          : (name) => `Nouveau match !`;
        const pushBody = isSpeedDateAlive
          ? () => `Vous avez jusqu'à ${slotEndLabel(slotType)} pour vous rencontrer !`
          : (name) => `${name} a matché avec toi`;
        const pushType = isSpeedDateAlive ? 'speed_date_match' : 'new_match';
        const pushCategory = isSpeedDateAlive ? 'speed_date' : 'match';

        sendPushToUser(likerId, pushTitle(likedName),     pushBody(likedName),     { match_id: matchId, type: pushType }, pushCategory);
        sendPushToUser(likedId, pushTitle(req.user.name), pushBody(req.user.name), { match_id: matchId, type: pushType }, pushCategory);
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
         l.speed_date_slot_type  AS speed_date_slot_type,
         l.speed_date_slot_date  AS speed_date_slot_date,
         -- Slot-alive flag: TRUE only while the captured slot is still within the Brussels window.
         -- afternoon dies at 18h, evening dies at 23h on slot_date. Symmetric to matches.js.
         -- UI uses this to pick orange (alive) vs grey (past) badge styling.
         (
           l.speed_date_slot_type IS NOT NULL
           AND l.speed_date_slot_date = (NOW() AT TIME ZONE 'Europe/Brussels')::date
           AND (
             (l.speed_date_slot_type = 'afternoon' AND EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Europe/Brussels') < 18)
             OR
             (l.speed_date_slot_type = 'evening'   AND EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Europe/Brussels') < 23)
           )
         )                                                              AS is_speed_date_alive,
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

      // If this super like is also a Speed Date like, capture the common slot.
      const likeSlot = isSpeedDate ? await getCommonSlotToday(likerId, likedId) : null;
      const likeSlotType = likeSlot?.slot_type ?? null;
      const likeSlotDate = likeSlot?.slot_date ?? null;

      const insertLike = await pool.query(
        `INSERT INTO likes (liker_id, liked_id, is_super, is_speed_date, speed_date_slot_type, speed_date_slot_date)
         VALUES ($1, $2, TRUE, $3, $4, $5)
         ON CONFLICT (liker_id, liked_id) DO UPDATE
           SET is_super      = TRUE,
               is_speed_date = likes.is_speed_date OR EXCLUDED.is_speed_date,
               speed_date_slot_type = COALESCE(EXCLUDED.speed_date_slot_type, likes.speed_date_slot_type),
               speed_date_slot_date = COALESCE(EXCLUDED.speed_date_slot_date, likes.speed_date_slot_date)
         RETURNING id, is_speed_date`,
        [likerId, likedId, isSpeedDate, likeSlotType, likeSlotDate]
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
        `SELECT is_speed_date FROM likes WHERE liker_id = $1 AND liked_id = $2`,
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
          sendPushToUser(
            likedId,
            "Quelqu'un t'a SUPER liké ⭐",
            "Découvre qui c'est",
            { type: 'new_like', is_super: true },
            'like'
          );
        }
        return res.status(201).json({
          like_id:       likeId,
          is_match:      false,
          is_super:      true,
          is_speed_date: likeRow.is_speed_date === true,
        });
      }

      // Capture the common slot if EITHER like is a Speed Date like.
      const reciprocalIsSpeedDate = reciprocal.rows[0]?.is_speed_date === true;
      const eitherIsSpeedDate = likeRow.is_speed_date === true || reciprocalIsSpeedDate;
      const matchSlot = eitherIsSpeedDate ? await getCommonSlotToday(likerId, likedId) : null;
      const slotType = matchSlot?.slot_type ?? null;
      const slotDate = matchSlot?.slot_date ?? null;

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

        // Enriched push for Speed Date matches (slotType captured above is non-null only when alive).
        const isSpeedDateAlive = slotType !== null;
        const pushTitle = isSpeedDateAlive
          ? (name) => `⚡ Match Speed Date avec ${name} !`
          : (name) => `Nouveau match !`;
        const pushBody = isSpeedDateAlive
          ? () => `Vous avez jusqu'à ${slotEndLabel(slotType)} pour vous rencontrer !`
          : (name) => `${name} a matché avec toi`;
        const pushType = isSpeedDateAlive ? 'speed_date_match' : 'new_match';
        const pushCategory = isSpeedDateAlive ? 'speed_date' : 'match';

        sendPushToUser(likerId, pushTitle(likedName),     pushBody(likedName),     { match_id: matchId, type: pushType }, pushCategory);
        sendPushToUser(likedId, pushTitle(req.user.name), pushBody(req.user.name), { match_id: matchId, type: pushType }, pushCategory);
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
