const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/auth');

// Routes à implémenter :
// GET /likes/received  → profils qui ont liké l'utilisateur connecté
// GET /likes/sent      → profils que l'utilisateur a likés

router.use(auth);

router.get('/received', (_req, res) => {
  res.status(501).json({ error: 'Not implemented' });
});

router.get('/sent', (_req, res) => {
  res.status(501).json({ error: 'Not implemented' });
});

module.exports = router;
