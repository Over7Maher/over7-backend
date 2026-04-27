const pool = require('../db/pool');

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
    // Reason hints at the actual cause so the frontend can route the modal CTA
    // (EditProfile for completude, Arena for rating). The 'rating' branch will
    // become unreachable once arena_validated lands; harmless until then.
    const reason = completudePct < 70
      ? 'completude_below_threshold'
      : 'rating_below_threshold';

    io?.to(`user:${userId}`).emit('pool_lost', {
      reason,
      completude_pct: completudePct,
    });

    await pool.query(
      `UPDATE users
          SET pool_exited_at    = NOW(),
              pool_exit_pending = TRUE
        WHERE id = $1`,
      [userId]
    );

    // No push notification here: the user is in-app when this fires (an active
    // profile edit is the only realistic trigger). Frontend listens for
    // 'pool_lost' and shows a modal, backed by pool_exit_pending for
    // next-focus persistence if missed.
  }
}

module.exports = { handlePoolTransition };
