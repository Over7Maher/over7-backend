require('dotenv').config();

const express      = require('express');
const http         = require('http');
const cors         = require('cors');
const helmet       = require('helmet');
const initSocket   = require('./services/socket');
const errorHandler = require('./middleware/errorHandler');

// ── Express + HTTP server ─────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// ── Socket.io ─────────────────────────────────────────────────────────────────
// initSocket attaches Socket.io to the HTTP server and returns the io instance.
// Routes access it via req.app.get('io') to broadcast after HTTP POSTs.
const io = initSocket(server);
app.set('io', io);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/users',    require('./routes/users'));
app.use('/api/arena',    require('./routes/arena'));
app.use('/api/likes',     require('./routes/likes'));
app.use('/api/discover', require('./routes/discover'));
app.use('/api/matches',  require('./routes/matches'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/upload',  require('./routes/upload'));
app.use('/api/test',   require('./routes/test'));   // TODO: remove after realtime testing

app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ── Error handler ─────────────────────────────────────────────────────────────
app.use(errorHandler);

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Over7 API running on port ${PORT}`));
