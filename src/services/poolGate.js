const POOL_COMPLETUDE_MIN = 70;
const POOL_VOTES_MIN = 20;

/**
 * Returns true if the user satisfies all conditions to enter the discovery pool:
 * completude >= 70%, has a location, and has cast >= 20 arena votes.
 */
function shouldBeInPool(user) {
  return (
    (user.completude_pct ?? 0) >= POOL_COMPLETUDE_MIN &&
    user.latitude != null &&
    user.longitude != null &&
    (user.arena_votes_given ?? 0) >= POOL_VOTES_MIN
  );
}

module.exports = { shouldBeInPool, POOL_COMPLETUDE_MIN, POOL_VOTES_MIN };
