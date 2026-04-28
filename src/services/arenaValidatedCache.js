const { LRUCache } = require('lru-cache');

/**
 * In-memory cache of users.arena_validated status, used by the
 * POST /api/arena/vote pre-flight check. Avoids hitting the DB
 * on every vote when the same target user is queried repeatedly.
 *
 * Capacity:  1000 entries (~70 KB max — UUIDs + booleans, comfortable
 *            margin for our user base)
 * TTL:       5 minutes (eventual consistency on multi-instance future
 *            deployments — defense-in-depth via the SQL UPDATE guard
 *            'AND arena_validated IS NOT TRUE' in arena.js handles
 *            concurrent transitions)
 *
 * Coherence:
 * - Read   : isArenaValidated(userId, pool) — returns true|false from
 *            cache, or null on cache miss + DB returns 0 rows (caller
 *            must materialize 404)
 * - Write  : setArenaValidated(userId) — pre-warm to true after a
 *            FALSE → TRUE transition (called by handleArenaValidation
 *            after the commit)
 * - Evict  : invalidateArenaValidatedCache(userId) — explicit
 *            invalidation (rarely needed in current flow)
 */
const cache = new LRUCache({ max: 1000, ttl: 1000 * 60 * 5 });

async function isArenaValidated(userId, pool) {
  const cached = cache.get(userId);
  if (cached !== undefined) return cached;

  const { rows } = await pool.query(
    'SELECT arena_validated FROM users WHERE id = $1',
    [userId]
  );
  if (rows.length === 0) return null;
  const validated = rows[0].arena_validated === true;
  cache.set(userId, validated);
  return validated;
}

function setArenaValidated(userId) {
  cache.set(userId, true);
}

function invalidateArenaValidatedCache(userId) {
  cache.delete(userId);
}

module.exports = {
  isArenaValidated,
  setArenaValidated,
  invalidateArenaValidatedCache,
};
