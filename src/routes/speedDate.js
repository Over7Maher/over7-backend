const express = require('express');
const { body, validationResult } = require('express-validator');
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

// Returns today's YYYY-MM-DD in Europe/Brussels. 'en-CA' locale conveniently
// formats as YYYY-MM-DD, so slicing the first 10 chars is safe.
function todayBrussels() {
  return new Date().toLocaleString('en-CA', { timeZone: 'Europe/Brussels' }).slice(0, 10);
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
// Registers the current user to today's afternoon or evening slot.
// Re-registering after a cancellation reactivates the row.
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/register',
  [body('slot_type').isIn(['afternoon', 'evening']).withMessage('slot_type must be afternoon or evening')],
  validate,
  async (req, res, next) => {
    try {
      if (req.user.is_in_pool !== true) {
        return res.status(403).json({ error: 'Access to Speed Date requires pool access' });
      }

      const slotDate = todayBrussels();

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
// Cancels today's registration(s). Optional ?slot_type=afternoon|evening
// restricts cancellation to a single slot.
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/register', async (req, res, next) => {
  try {
    const slotType = req.query.slot_type;
    const slotDate = todayBrussels();

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
    sql += ` RETURNING id, slot_type`;

    const { rows } = await pool.query(sql, params);
    res.json({ cancelled: rows.length, registrations: rows });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/speed-date/my-slots ─────────────────────────────────────────────
// Lists the current user's active registrations for today, plus whether a
// slot is running right now and whether they are registered to it.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/my-slots', async (req, res, next) => {
  try {
    const slotDate = todayBrussels();

    const { rows } = await pool.query(
      `SELECT id, slot_type, slot_date, created_at
       FROM speed_date_registrations
       WHERE user_id = $1
         AND slot_date = $2
         AND cancelled_at IS NULL
       ORDER BY created_at DESC`,
      [req.user.id, slotDate]
    );

    const current = getCurrentSlot();
    const isRegisteredNow = current
      ? rows.some(r => r.slot_type === current.slot_type && r.slot_date === current.slot_date)
      : false;

    res.json({
      current_slot:       current,
      registrations:      rows,
      is_registered_now:  isRegisteredNow,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/speed-date/profiles ─────────────────────────────────────────────
// Profiles to swipe within the current slot: same slot registration,
// <=20km, is_in_pool, gender/seeking reciprocity, not self/blocked/liked/matched.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/profiles', async (req, res, next) => {
  try {
    const current = getCurrentSlot();
    if (!current) {
      return res.status(400).json({ error: 'No active slot at this time' });
    }

    const me = req.user;
    if (me.is_in_pool !== true) {
      return res.status(403).json({ error: 'Pool access required' });
    }
    if (me.latitude == null || me.longitude == null) {
      return res.status(400).json({ error: 'Location required' });
    }

    // Current user must themselves be registered to the live slot.
    const { rows: myReg } = await pool.query(
      `SELECT 1 FROM speed_date_registrations
       WHERE user_id    = $1
         AND slot_date  = $2
         AND slot_type  = $3
         AND cancelled_at IS NULL`,
      [me.id, current.slot_date, current.slot_type]
    );
    if (myReg.length === 0) {
      return res.status(403).json({ error: 'You must register to the current slot first' });
    }

    const myLat     = parseFloat(me.latitude);
    const myLng     = parseFloat(me.longitude);
    const myGender  = me.gender ?? null;
    const mySeeking = (me.seeking === 'male' || me.seeking === 'female') ? me.seeking : null;

    const limit  = Math.min(parseInt(req.query.limit, 10)  || 20, 50);
    const offset = parseInt(req.query.offset, 10) || 0;

    const { rows } = await pool.query(
      `WITH candidates AS (
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
         INNER JOIN speed_date_registrations sdr ON sdr.user_id = u.id
         WHERE sdr.slot_date     = $4
           AND sdr.slot_type     = $5
           AND sdr.cancelled_at IS NULL
           AND u.id        != $1
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
       ORDER BY dist_km ASC, avg_rating DESC NULLS LAST
       LIMIT  $8
       OFFSET $9`,
      [
        me.id, myLat, myLng,
        current.slot_date, current.slot_type,
        mySeeking, myGender,
        limit, offset,
      ]
    );

    res.json({
      profiles:         rows,
      count:            rows.length,
      slot:             current,
      offset,
      no_more_profiles: rows.length < limit,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
