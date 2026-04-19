const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const auth = require('../middleware/auth');

const router = express.Router();

router.use(auth);

const VALID_REASONS = ['spam', 'harassment', 'fake_profile', 'inappropriate', 'other'];

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });
  next();
}

// ── POST /api/reports ─────────────────────────────────────────────────────────
// Report a user for moderation review.
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/',
  [
    body('reported_id')
      .isUUID()
      .withMessage('reported_id must be a valid UUID'),
    body('reason')
      .isIn(VALID_REASONS)
      .withMessage(`reason must be one of: ${VALID_REASONS.join(', ')}`),
    body('details')
      .optional()
      .isString()
      .isLength({ max: 500 })
      .withMessage('details must be a string of at most 500 characters'),
  ],
  validate,
  async (req, res, next) => {
    const reporterId = req.user.id;
    const { reported_id, reason, details } = req.body;

    if (reporterId === reported_id) {
      return res.status(400).json({ error: 'You cannot report yourself' });
    }

    try {
      const { rows } = await pool.query(
        `INSERT INTO reports (reporter_id, reported_id, reason, details)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [reporterId, reported_id, reason, details ?? null]
      );

      res.status(201).json({ report_id: rows[0].id });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
