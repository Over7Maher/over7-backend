const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const getAdmin = require('./firebaseAdmin');
const pool     = require('../db/pool');

/**
 * initSocket(server)
 *
 * Attaches Socket.io to the HTTP server, sets up Firebase auth middleware,
 * and registers all real-time events.
 *
 * Events (client → server):
 *   join_match   { matchId }            — join a match room
 *   send_message { matchId, content }   — send a message (saved to DB + broadcast)
 *   typing       { matchId, is_typing } — typing indicator broadcast
 *
 * Events (server → client):
 *   joined_match { matchId }            — confirmed room join
 *   new_message  Message                — new message broadcast to room
 *   typing       { user_id, name, is_typing }
 *   error        { message }            — operation-level error
 *
 * Returns the io instance so app.js can store it on the Express app.
 */
function initSocket(server) {
  const io = new Server(server, {
    cors:              { origin: '*', methods: ['GET', 'POST'] },
    pingTimeout:       20000,
    pingInterval:      10000,
    transports:        ['websocket', 'polling'],
  });

  // ── Auth middleware ─────────────────────────────────────────────────────────
  // Every connecting socket must send a valid Firebase ID token:
  //   socket = io('...', { auth: { token: '<firebaseIdToken>' } })
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('AUTH_REQUIRED'));

    try {
      const decoded = await getAdmin().auth().verifyIdToken(token);
      const { rows } = await pool.query(
        'SELECT id, name FROM users WHERE firebase_uid = $1 AND is_active = TRUE',
        [decoded.uid]
      );
      if (!rows.length) return next(new Error('USER_NOT_FOUND'));
      socket.user = rows[0];   // { id, name }
      next();
    } catch {
      next(new Error('INVALID_TOKEN'));
    }
  });

  // ── Helper: verify match membership ────────────────────────────────────────
  async function assertMembership(matchId, userId) {
    const { rows } = await pool.query(
      `SELECT id FROM matches
       WHERE id = $1
         AND (user1_id = $2 OR user2_id = $2)
         AND is_active = TRUE`,
      [matchId, userId]
    );
    return rows.length > 0;
  }

  // ── Connection ──────────────────────────────────────────────────────────────
  io.on('connection', (socket) => {
    console.log(`[socket] + ${socket.user.name} (${socket.user.id})`);

    // ── join_match ────────────────────────────────────────────────────────────
    // Client joins a room identified by match_id.
    // Membership is verified against the DB before admission.
    socket.on('join_match', async (matchId) => {
      if (typeof matchId !== 'string') {
        return socket.emit('error', { message: 'matchId must be a string' });
      }
      try {
        const ok = await assertMembership(matchId, socket.user.id);
        if (!ok) return socket.emit('error', { message: 'Match not found or access denied' });

        socket.join(`match:${matchId}`);
        socket.emit('joined_match', { matchId });
        console.log(`[socket] ${socket.user.name} joined match:${matchId}`);
      } catch {
        socket.emit('error', { message: 'Failed to join match' });
      }
    });

    // ── send_message ──────────────────────────────────────────────────────────
    // Saves to DB then broadcasts to everyone in the room (including sender,
    // so the sender gets the DB-stamped message back as confirmation).
    socket.on('send_message', async ({ matchId, content }) => {
      if (typeof matchId !== 'string' || typeof content !== 'string') {
        return socket.emit('error', { message: 'matchId and content are required strings' });
      }
      const trimmed = content.trim();
      if (!trimmed)          return socket.emit('error', { message: 'Message cannot be empty' });
      if (trimmed.length > 1000) return socket.emit('error', { message: 'Message exceeds 1000 characters' });

      try {
        const ok = await assertMembership(matchId, socket.user.id);
        if (!ok) return socket.emit('error', { message: 'Access denied' });

        const { rows } = await pool.query(
          `INSERT INTO messages (id, match_id, sender_id, content)
           VALUES ($1, $2, $3, $4)
           RETURNING id, match_id, sender_id, content, read_at, created_at`,
          [uuidv4(), matchId, socket.user.id, trimmed]
        );

        const message = { ...rows[0], sender_name: socket.user.name };
        io.to(`match:${matchId}`).emit('new_message', message);
      } catch {
        socket.emit('error', { message: 'Failed to send message' });
      }
    });

    // ── typing ────────────────────────────────────────────────────────────────
    // Broadcasts typing state to other members only (socket.to excludes sender).
    // Client sends  { matchId, is_typing: true|false }
    socket.on('typing', ({ matchId, is_typing }) => {
      if (typeof matchId !== 'string') return;
      socket.to(`match:${matchId}`).emit('typing', {
        user_id:   socket.user.id,
        name:      socket.user.name,
        is_typing: !!is_typing,
      });
    });

    // ── disconnect ────────────────────────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      console.log(`[socket] - ${socket.user.name} (${reason})`);
    });
  });

  return io;
}

module.exports = initSocket;
