const express = require('express');
const multer  = require('multer');
const auth    = require('../middleware/auth');
const { uploadPhoto } = require('../services/cloudinary');

const router = express.Router();
router.use(auth);

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

const storage = multer.memoryStorage();

function fileFilter(_req, file, cb) {
  if (ALLOWED_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
  }
}

const uploadSingle   = multer({ storage, fileFilter, limits: { fileSize: MAX_SIZE_BYTES } }).single('photo');
const uploadMultiple = multer({ storage, fileFilter, limits: { fileSize: MAX_SIZE_BYTES } }).array('photos', 6);

// ── POST /api/upload/photo ────────────────────────────────────────────────────
router.post('/photo', (req, res, next) => {
  uploadSingle(req, res, async (err) => {
    if (err) return next(err);
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    try {
      const url = await uploadPhoto(req.file.buffer, req.user.id);
      res.status(201).json({ url });
    } catch (err) {
      next(err);
    }
  });
});

// ── POST /api/upload/photos ───────────────────────────────────────────────────
router.post('/photos', (req, res, next) => {
  uploadMultiple(req, res, async (err) => {
    if (err) return next(err);
    if (!req.files?.length) return res.status(400).json({ error: 'No files provided' });

    try {
      const urls = await Promise.all(
        req.files.map((f) => uploadPhoto(f.buffer, req.user.id))
      );
      res.status(201).json({ urls });
    } catch (err) {
      next(err);
    }
  });
});

module.exports = router;
