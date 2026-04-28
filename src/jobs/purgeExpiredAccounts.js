const pool = require('../db/pool');
const { deleteUserPhotos } = require('../services/cloudinary');

const PURGE_DELAY_DAYS = 30;
const BATCH_SIZE       = 100;

/**
 * Permanently deletes accounts that requested deletion more than
 * PURGE_DELAY_DAYS days ago. Two-step process per user:
 *   1. Delete all photos from Cloudinary (out-of-DB cleanup)
 *   2. DELETE FROM users — cascades via FK ON DELETE CASCADE to
 *      arena_votes, blocks, likes, matches, messages, reports,
 *      speed_date_registrations, user_prompts (per schema.sql + the
 *      ad-hoc historical migrations confirmed via information_schema).
 *
 * Idempotent + resilient:
 * - Cloudinary failure → log, skip to DB delete (orphan assets accepted)
 * - DB failure on one user → log, skip to next (retried next run since
 *   the WHERE clause still matches until the row is gone)
 *
 * Capped at BATCH_SIZE per run so a backlog never blocks the cron tick.
 * The job runs daily so even thousands of pending purges drain inside
 * a couple of weeks.
 */
async function purgeExpiredAccounts() {
  const { rows } = await pool.query(
    `SELECT id FROM users
      WHERE is_active = FALSE
        AND deleted_at IS NOT NULL
        AND deleted_at < NOW() - INTERVAL '${PURGE_DELAY_DAYS} days'
      LIMIT $1`,
    [BATCH_SIZE]
  );

  if (rows.length === 0) {
    console.log('[purge] no accounts to purge');
    return { purged: 0 };
  }

  console.log(`[purge] starting purge of ${rows.length} expired account(s)`);

  let purgedCount = 0;
  for (const { id: userId } of rows) {
    try {
      try {
        const photoResult = await deleteUserPhotos(userId);
        console.log(`[purge] cloudinary cleanup user=${userId}:`, photoResult);
      } catch (err) {
        console.error(`[purge] cloudinary failed for user=${userId}:`, err.message);
      }

      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
      console.log(`[purge] db row deleted user=${userId}`);
      purgedCount++;
    } catch (err) {
      console.error(`[purge] failed for user=${userId}:`, err.message);
    }
  }

  console.log(`[purge] completed: ${purgedCount}/${rows.length} purged`);
  return { purged: purgedCount, attempted: rows.length };
}

module.exports = { purgeExpiredAccounts, PURGE_DELAY_DAYS, BATCH_SIZE };
