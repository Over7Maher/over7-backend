const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const auth = require('../middleware/auth');
const haversineSQL = require('../db/haversine');
const { notBlockedClause } = require('../db/blocks');

const router = express.Router();

router.use(auth);

const REGISTRATION_WINDOW_DAYS = 7;   // today + next 6 days

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });
  next();
}

// Returns today's YYYY-MM-DD in Europe/Brussels. 'en-CA' locale conveniently
// formats as YYYY-MM-DD, so slicing the first 10 chars is safe.
function todayBrussels() {
  return new Date().toLocaleString('en-CA', { timeZone: 'Europe/Brussels' }).slice(0, 10);
}

// Adds `days` calendar days to a YYYY-MM-DD string. Treats the input as UTC
// midnight so arithmetic doesn't cross DST boundaries unintentionally.
function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Normalizes a pg DATE result (either a JS Date or a YYYY-MM-DD string,
// depending on pg.types config) to a plain YYYY-MM-DD string.
function toDateStr(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

// Returns the currently-active slot in Europe/Brussels, or null when outside
// both windows. afternoon = [14h, 18h), evening = [19h, 23h).
function getCurrentSlot() {
  const brusselsNow = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Europe/Brussels' })
  );
  const hour = brusselsNow.getHours();
  const slotDate = todayBrussels();

  if (hour >= 14 && hour < 18) return { slot_type: 'afternoon', slot_date: slotDate };
  if (hour >= 19 && hour < 23) return { slot_type: 'evening',   slot_date: slotDate };
  return null;
}

// ── POST /api/speed-date/register ────────────────────────────────────────────
// Registers the current user to any slot in the next 7 days (today included).
// body: { slot_type, slot_date? } — slot_date defaults to today (Brussels).
// Re-registering after a cancellation reactivates the row.
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/register',
  [
    body('slot_type').isIn(['afternoon', 'evening']).withMessage('slot_type must be afternoon or evening'),
    body('slot_date').optional().isISO8601().withMessage('slot_date must be YYYY-MM-DD'),
  ],
  validate,
  async (req, res, next) => {
    try {
      if (req.user.is_in_pool !== true) {
        return res.status(403).json({ error: 'Access to Speed Date requires pool access' });
      }

      const today    = todayBrussels();
      const maxDate  = addDays(today, REGISTRATION_WINDOW_DAYS - 1);
      const slotDate = req.body.slot_date
        ? String(req.body.slot_date).slice(0, 10)
        : today;

      if (slotDate < today || slotDate > maxDate) {
        return res.status(400).json({
          error: `slot_date must be between ${today} and ${maxDate} (inclusive)`,
        });
      }

      const { rows } = await pool.query(
        `INSERT INTO speed_date_registrations (user_id, slot_date, slot_type)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, slot_date, slot_type)
           DO UPDATE SET cancelled_at = NULL, created_at = NOW()
         RETURNING id, slot_date, slot_type, created_at`,
        [req.user.id, slotDate, req.body.slot_type]
      );

      res.status(201).json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// ── DELETE /api/speed-date/register ──────────────────────────────────────────
// Cancels registration(s). Query params:
//   slot_date — optional, defaults to today (Brussels)
//   slot_type — optional, cancels both slots for that date when absent
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/register', async (req, res, next) => {
  try {
    const slotType = req.query.slot_type;
    const slotDate = req.query.slot_date
      ? String(req.query.slot_date).slice(0, 10)
      : todayBrussels();

    const params = [req.user.id, slotDate];
    let sql = `UPDATE speed_date_registrations
               SET cancelled_at = NOW()
               WHERE user_id = $1
                 AND slot_date = $2
                 AND cancelled_at IS NULL`;

    if (slotType) {
      params.push(slotType);
      sql += ` AND slot_type = $3`;
    }
    sql += ` RETURNING id, slot_type, slot_date`;

    const { rows } = await pool.query(sql, params);
    res.json({ cancelled: rows.length, registrations: rows });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/speed-date/my-slots ─────────────────────────────────────────────
// Lists the current user's active registrations for the 7-day window starting
// today, plus the running slot (if any) and whether the user is registered to it.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/my-slots', async (req, res, next) => {
  try {
    const today   = todayBrussels();
    const maxDate = addDays(today, REGISTRATION_WINDOW_DAYS - 1);

    const { rows } = await pool.query(
      `SELECT id, slot_type, slot_date, created_at
       FROM speed_date_registrations
       WHERE user_id = $1
         AND slot_date BETWEEN $2 AND $3
         AND cancelled_at IS NULL
       ORDER BY slot_date ASC, created_at DESC`,
      [req.user.id, today, maxDate]
    );

    const current = getCurrentSlot();
    const isRegisteredNow = current
      ? rows.some(r =>
          r.slot_type === current.slot_type &&
          toDateStr(r.slot_date) === current.slot_date
        )
      : false;

    res.json({
      current_slot:      current,
      registrations:     rows,
      is_registered_now: isRegisteredNow,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/speed-date/slots-grid ───────────────────────────────────────────
// Returns a 7-day grid with the user's registration state per slot, for
// rendering the frontend calendar grid.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/slots-grid', async (req, res, next) => {
  try {
    const today = todayBrussels();
    const dates = Array.from(
      { length: REGISTRATION_WINDOW_DAYS },
      (_, i) => addDays(today, i)
    );

    const { rows: registrations } = await pool.query(
      `SELECT slot_date, slot_type
       FROM speed_date_registrations
       WHERE user_id     = $1
         AND slot_date   = ANY($2::date[])
         AND cancelled_at IS NULL`,
      [req.user.id, dates]
    );

    // Index by date for O(1) lookup across the 7-day grid.
    const byDate = new Map();
    for (const r of registrations) {
      const d = toDateStr(r.slot_date);
      const entry = byDate.get(d) ?? { afternoon: false, evening: false };
      entry[r.slot_type] = true;
      byDate.set(d, entry);
    }

    const grid = dates.map(date => ({
      slot_date: date,
      afternoon: byDate.get(date)?.afternoon ?? false,
      evening:   byDate.get(date)?.evening   ?? false,
    }));

    res.json({ grid, today });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/speed-date/profiles ─────────────────────────────────────────────
// Profiles to swipe, drawn from users registered TODAY to AT LEAST ONE of the
// slots the current user is registered to today. Available all day (not gated
// by the 14-18 / 19-23 windows). Profiles registered to the running slot are
// surfaced first when one is active.
//
// Filters: is_in_pool, is_active, gender/seeking reciprocity, within 20 km,
// excluding self / blocks / existing likes / active matches.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/profiles', async (req, res, next) => {
  try {
    const me = req.user;
    if (me.is_in_pool !== true) {
      return res.status(403).json({ error: 'Pool access required' });
    }
    if (me.latitude == null || me.longitude == null) {
      return res.status(400).json({ error: 'Location required' });
    }

    const today   = todayBrussels();
    const current = getCurrentSlot();   // may be null

    const { rows: mySlots } = await pool.query(
      `SELECT slot_type FROM speed_date_registrations
       WHERE user_id = $1
         AND slot_date = $2
         AND cancelled_at IS NULL`,
      [me.id, today]
    );

    if (mySlots.length === 0) {
      return res.status(403).json({ error: "You must register to today's slots first" });
    }

    const mySlotTypes = mySlots.map(r => r.slot_type);
    const myLat       = parseFloat(me.latitude);
    const myLng       = parseFloat(me.longitude);
    const myGender    = me.gender ?? null;
    const mySeeking   = (me.seeking === 'male' || me.seeking === 'female') ? me.seeking : null;
    const currentType = current ? current.slot_type : '';

    const limit  = Math.min(parseInt(req.query.limit, 10)  || 20, 50);
    const offset = parseInt(req.query.offset, 10) || 0;

    const { rows } = await pool.query(
      `WITH profile_slots AS (
         SELECT
           sdr.user_id,
           array_agg(sdr.slot_type ORDER BY sdr.slot_type) AS slot_types,
           BOOL_OR(sdr.slot_type = $8::TEXT)               AS in_current_slot
         FROM speed_date_registrations sdr
         WHERE sdr.slot_date     = $4
           AND sdr.cancelled_at IS NULL
           AND sdr.slot_type     = ANY($5::TEXT[])
         GROUP BY sdr.user_id
       ),
       candidates AS (
         SELECT
           u.id, u.name, u.birth_date, u.bio, u.city,
           u.profile_picture_url, u.photos, u.tags,
           u.relation_type, u.height_cm, u.languages,
           u.astro_sign, u.education, u.job_title, u.company,
           u.family_plans, u.communication_style, u.love_language,
           u.pet, u.alcohol, u.tobacco, u.sport,
           u.evenings_type, u.weekends_type, u.favorite_song,
           u.social_media, u.gender,
           u.avg_rating, u.completude_pct,
           ps.slot_types,
           ps.in_current_slot,
           (
             SELECT json_agg(
               json_build_object(
                 'prompt_id', up.prompt_id,
                 'question',  pc.question,
                 'answer',    up.answer,
                 'position',  up.position
               ) ORDER BY up.position
             )
             FROM user_prompts up
             JOIN prompts_catalog pc ON pc.id = up.prompt_id
             WHERE up.user_id = u.id
           ) AS prompts,
           ${haversineSQL('$2', '$3', 'u')} AS dist_km
         FROM users u
         INNER JOIN profile_slots ps ON ps.user_id = u.id
         WHERE u.id        != $1
           AND u.is_active  = TRUE
           AND u.is_in_pool = TRUE
           AND u.latitude  IS NOT NULL
           AND u.longitude IS NOT NULL
           AND ($6::TEXT IS NULL OR u.gender = $6)
           AND (u.seeking IS NULL OR u.seeking = 'all' OR u.seeking = $7::TEXT)
           AND ${notBlockedClause('$1', 'u')}
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
       WHERE dist_km <= 20
       ORDER BY in_current_slot DESC, dist_km ASC, avg_rating DESC NULLS LAST
       LIMIT  $9
       OFFSET $10`,
      [
        me.id, myLat, myLng,
        today, mySlotTypes,
        mySeeking, myGender,
        currentType,
        limit, offset,
      ]
    );

    res.json({
      profiles:         rows,
      count:            rows.length,
      my_slots:         mySlotTypes,
      current_slot:     current,
      offset,
      no_more_profiles: rows.length < limit,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
