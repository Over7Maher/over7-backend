const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const auth = require('../middleware/auth');

const router = express.Router();

router.use(auth);

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });
  next();
}

// ── POST /api/bug-reports ─────────────────────────────────────────────────────
// Submit an in-app bug report (Settings → "Signaler un bug").
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/',
  [
    body('action')
      .isString()
      .trim()
      .isLength({ min: 1, max: 500 })
      .withMessage('action must be a non-empty string of at most 500 characters'),
    body('description')
      .isString()
      .trim()
      .isLength({ min: 1, max: 2000 })
      .withMessage('description must be a non-empty string of at most 2000 characters'),
    body('device_info')
      .optional()
      .isString()
      .isLength({ max: 200 })
      .withMessage('device_info must be a string of at most 200 characters'),
    body('os_info')
      .optional()
      .isString()
      .isLength({ max: 200 })
      .withMessage('os_info must be a string of at most 200 characters'),
    body('app_version')
      .optional()
      .isString()
      .isLength({ max: 200 })
      .withMessage('app_version must be a string of at most 200 characters'),
  ],
  validate,
  async (req, res, next) => {
    const userId = req.user.id;
    const { action, description, device_info, os_info, app_version } = req.body;

    try {
      const { rows } = await pool.query(
        `INSERT INTO bug_reports (user_id, action, description, device_info, os_info, app_version)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, created_at`,
        [
          userId,
          action,
          description,
          device_info ?? null,
          os_info ?? null,
          app_version ?? null,
        ]
      );

      res.status(201).json({ id: rows[0].id, created_at: rows[0].created_at });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
