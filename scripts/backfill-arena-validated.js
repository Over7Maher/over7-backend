/**
 * Backfill arena_validated for users who already meet the criteria
 * (arena_votes_received >= 20 AND avg_rating >= 7) but were created
 * before the arena_validated column existed.
 *
 * Idempotent: only updates rows where arena_validated IS NOT TRUE,
 * so re-running does nothing.
 *
 * Sets pending=FALSE so these users don't get a retroactive
 * celebration modal at their next login (the validation actually
 * happened "in the past", not now).
 *
 * Usage: railway run --service over7-backend node scripts/backfill-arena-validated.js
 */

const pool = require('../src/db/pool');

(async () => {
  try {
    console.log('=== Arena Validated Backfill ===\n');

    const before = await pool.query(`
      SELECT id, name, arena_votes_received, avg_rating
      FROM users
      WHERE arena_votes_received >= 20
        AND avg_rating >= 7
        AND arena_validated IS NOT TRUE
      ORDER BY avg_rating DESC, arena_votes_received DESC
    `);

    console.log(`Found ${before.rows.length} candidate(s):`);
    before.rows.forEach(r => {
      console.log(`  - ${r.name} (${r.id}): ${r.arena_votes_received} votes, avg ${r.avg_rating}`);
    });

    if (before.rows.length === 0) {
      console.log('\nNothing to backfill. Exiting.');
      await pool.end();
      return;
    }

    console.log('\nApplying backfill...');
    const result = await pool.query(`
      UPDATE users
      SET arena_validated         = TRUE,
          arena_validated_at      = NOW(),
          arena_validated_pending = FALSE
      WHERE arena_votes_received >= 20
        AND avg_rating >= 7
        AND arena_validated IS NOT TRUE
      RETURNING id, name, arena_validated_at
    `);

    console.log(`\nUpdated ${result.rows.length} user(s):`);
    result.rows.forEach(r => {
      console.log(`  - ${r.name}: validated at ${r.arena_validated_at.toISOString()}`);
    });

    const after = await pool.query(
      `SELECT COUNT(*)::int AS total FROM users WHERE arena_validated = TRUE`
    );
    console.log(`\nTotal validated users in DB: ${after.rows[0].total}`);

    await pool.end();
    console.log('\n=== Done ===');
  } catch (err) {
    console.error('Backfill failed:', err);
    await pool.end();
    process.exit(1);
  }
})();
