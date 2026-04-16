/**
 * Central error handler — must be registered last in app.js.
 * Handles express-validator errors, known HTTP errors, and fallback 500s.
 */
function errorHandler(err, _req, res, _next) {
  // express-validator ValidationError array
  if (Array.isArray(err)) {
    return res.status(422).json({ errors: err });
  }

  const status  = err.status || err.statusCode || 500;
  const message = err.message || 'Internal server error';

  if (status >= 500) {
    console.error('[Error]', err);
  }

  res.status(status).json({ error: message });
}

module.exports = errorHandler;
