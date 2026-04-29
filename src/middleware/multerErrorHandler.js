const multer = require('multer');

// Express error middleware that translates Multer errors into proper HTTP
// status + human-readable messages. Non-Multer errors pass through to the
// global errorHandler unchanged.
//
// Note: our fileFilter (src/routes/upload.js) reuses LIMIT_UNEXPECTED_FILE
// to reject disallowed mimetypes, so that code is mapped to a format-error
// message rather than the literal "unexpected field".
function multerErrorHandler(err, _req, res, next) {
  if (!(err instanceof multer.MulterError)) {
    return next(err);
  }

  switch (err.code) {
    case 'LIMIT_FILE_SIZE':
      return res.status(413).json({ error: 'Fichier trop volumineux (max 5 MB)' });
    case 'LIMIT_FILE_COUNT':
      return res.status(400).json({ error: 'Trop de fichiers (max 6)' });
    case 'LIMIT_UNEXPECTED_FILE':
      return res.status(400).json({ error: 'Format de fichier non supporté (jpg/png/webp uniquement)' });
    default:
      return res.status(400).json({ error: `Upload error: ${err.code}` });
  }
}

module.exports = multerErrorHandler;
