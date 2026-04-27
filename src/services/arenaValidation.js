const pool = require('../db/pool');
const { sendPushToUser } = require('./push');

/**
 * Called after a vote on `userId` has been recorded and avg_rating recalculated.
 * Detects the first time the validation criteria flip from false to true:
 *   arena_votes_received >= 20 AND avg_rating >= 7
 *
 * One-way switch: once validated, never un-validated. Side effects on transition:
 *   - UPDATE arena_validated=TRUE, arena_validated_at=COALESCE(arena_validated_at, NOW()),
 *     arena_validated_pending=TRUE
 *   - emit socket 'arena_validated' { avg_rating, votes_received }
 *   - sendPushToUser with category='arena_milestone' (opt-out-able)
 *
 * Usage:
 *   await handleArenaValidation({
 *     io: req.app.get('io'),
 *     userId,
 *     wasValidated,    // bool — state BEFORE the vote
 *     votesReceived,   // int — fresh value from RETURNING
 *     avgRating,       // number — fresh value from RETURNING (cast from NUMERIC)
 *   });
 */
async function handleArenaValidation({ io, userId, wasValidated, votesReceived, avgRating }) {
  if (wasValidated) return;
  if (votesReceived < 20 || avgRating == null || avgRating < 7) return;

  await pool.query(
    `UPDATE users
        SET arena_validated         = TRUE,
            arena_validated_at      = COALESCE(arena_validated_at, NOW()),
            arena_validated_pending = TRUE
      WHERE id = $1`,
    [userId]
  );

  io?.to(`user:${userId}`).emit('arena_validated', {
    avg_rating:     avgRating,
    votes_received: votesReceived,
  });

  // Opt-out-able via 'arena_milestone' category — celebratory, not critical.
  sendPushToUser(
    userId,
    'Tu es validé dans l\'Arena !',
    "La communauté t'a validé. Ton score est figé.",
    { type: 'arena_validated', avg_rating: avgRating, votes_received: votesReceived },
    'arena_milestone'
  );
}

module.exports = { handleArenaValidation };
