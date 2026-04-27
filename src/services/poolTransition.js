const pool = require('../db/pool');
const { sendPushToUser } = require('./push');

/**
 * Called after the row's is_in_pool flag has been updated. Detects entry/exit
 * transitions and triggers the side effects: socket events, DB tracking flags
 * (pool_unlocked_pending / pool_exit_pending), and a push on exit.
 *
 * Usage:
 *   await handlePoolTransition({
 *     io: req.app.get('io'),
 *     userId,
 *     wasInPool,
 *     isInPool,
 *     completudePct,
 *   });
 */
async function handlePoolTransition({ io, userId, wasInPool, isInPool, completudePct }) {
  // Entry: false → true
  if (!wasInPool && isInPool) {
    io?.to(`user:${userId}`).emit('pool_unlocked');

    await pool.query(
      `UPDATE users
          SET pool_unlocked_pending = TRUE,
              pool_unlocked_at      = NOW()
        WHERE id = $1 AND pool_unlocked_at IS NULL`,
      [userId]
    );
    return;
  }

  // Exit: true → false
  if (wasInPool && !isInPool) {
    // Pick the most likely cause for the message. Until arena_validated lands,
    // an exit can also be triggered by avg_rating dropping below threshold —
    // claiming "profil sous 70%" in that case would be wrong.
    const reason = completudePct < 70 ? 'completude' : 'rating';
    const body   = reason === 'completude'
      ? 'Profil sous 70%. Reviens compléter.'
      : "Ton profil n'est plus éligible. Vérifie ton score.";

    io?.to(`user:${userId}`).emit('pool_lost', {
      reason: reason === 'completude'
        ? 'completude_below_threshold'
        : 'rating_below_threshold',
      completude_pct: completudePct,
    });

    await pool.query(
      `UPDATE users
          SET pool_exited_at    = NOW(),
              pool_exit_pending = TRUE
        WHERE id = $1`,
      [userId]
    );

    // Non opt-out (category=null) — transactional/critical: the user is now
    // blocked from Speed Date and Discover, they must be told.
    sendPushToUser(
      userId,
      "Tu n'es plus dans le pool",
      body,
      { type: 'pool_exit', reason, completude_pct: completudePct },
      null
    );
  }
}

module.exports = { handlePoolTransition };
