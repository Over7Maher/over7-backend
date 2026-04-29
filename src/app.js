require('dotenv').config();

const express      = require('express');
const http         = require('http');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const initSocket   = require('./services/socket');
const errorHandler = require('./middleware/errorHandler');
const { scheduleJobs } = require('./jobs/scheduler');

// ── Express + HTTP server ─────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// Railway runs the API behind a reverse proxy. Tell Express to trust the
// X-Forwarded-* headers so express-rate-limit can correctly identify clients
// by their real IP. Use 1 (single hop) rather than true to avoid trusting
// arbitrary upstream proxies — true would let clients spoof X-Forwarded-For
// and bypass rate limits.
app.set('trust proxy', 1);

// ── Socket.io ─────────────────────────────────────────────────────────────────
// initSocket attaches Socket.io to the HTTP server and returns the io instance.
// Routes access it via req.app.get('io') to broadcast after HTTP POSTs.
const io = initSocket(server);
app.set('io', io);

// ── CORS ──────────────────────────────────────────────────────────────────────
// Whitelist via env var ALLOWED_ORIGINS (CSV). When unset, allow everything
// (dev-friendly default). Requests without an Origin header (Postman,
// native mobile clients) are always allowed.
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
  : null;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    if (!origin)                              return callback(null, true);
    if (!allowedOrigins)                      return callback(null, true);
    if (allowedOrigins.includes(origin))      return callback(null, true);
    callback(new Error('CORS: origin not allowed'));
  },
  credentials: true,
}));
app.use(express.json());

// ── Rate limiters ─────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs:          15 * 60 * 1000,
  max:               300,
  standardHeaders:   true,
  legacyHeaders:     false,
  message:           { error: 'Too many requests, please try again later' },
});
app.use(globalLimiter);

const authLimiter = rateLimit({
  windowMs:          15 * 60 * 1000,
  max:               10,
  standardHeaders:   true,
  legacyHeaders:     false,
  message:           { error: 'Too many auth attempts, please try again later' },
});

const likesLimiter = rateLimit({
  windowMs:          60 * 1000,
  max:               60,
  standardHeaders:   true,
  legacyHeaders:     false,
  message:           { error: 'Too many likes, please slow down' },
});

const messagesLimiter = rateLimit({
  windowMs:          60 * 1000,
  max:               100,
  standardHeaders:   true,
  legacyHeaders:     false,
  message:           { error: 'Too many messages, please slow down' },
});

const reportsLimiter = rateLimit({
  windowMs:          60 * 60 * 1000,
  max:               5,
  standardHeaders:   true,
  legacyHeaders:     false,
  message:           { error: 'Too many reports, please try again later' },
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/users/register', authLimiter);
app.use('/api/likes',          likesLimiter);
app.use('/api/messages',       messagesLimiter);
app.use('/api/reports',        reportsLimiter);

app.use('/api/users',    require('./routes/users'));
app.use('/api/arena',    require('./routes/arena'));
app.use('/api/likes',     require('./routes/likes'));
app.use('/api/prompts',  require('./routes/prompts'));
app.use('/api/discover', require('./routes/discover'));
app.use('/api/matches',  require('./routes/matches'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/upload',  require('./routes/upload'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/blocks',  require('./routes/blocks'));
app.use('/api/speed-date', require('./routes/speedDate'));
app.use('/api/bug-reports', require('./routes/bug-reports'));
app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ── Error handler ─────────────────────────────────────────────────────────────
app.use(errorHandler);

// ── Start ─────────────────────────────────────────────────────────────────────
// Guard so supertest can `require('../app')` to mount routes without binding
// a port or starting cron jobs. The real server still boots when this file is
// run as the entrypoint (npm start / node src/app.js).
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`Over7 API running on port ${PORT}`);
    scheduleJobs();
  });
}

module.exports = app;
