const POOL_COMPLETUDE_MIN = 70;
const POOL_VOTES_GIVEN_MIN = 20;
const POOL_VOTES_RECEIVED_MIN = 20;

/**
 * Returns true if the user satisfies all conditions to enter the discovery pool:
 * completude >= 70%, has a location, has cast >= 20 arena votes, and received >= 20.
 */
function shouldBeInPool(user) {
  return (
    (user.completude_pct ?? 0) >= POOL_COMPLETUDE_MIN &&
    user.latitude != null &&
    user.longitude != null &&
    (user.arena_votes_given ?? 0) >= POOL_VOTES_GIVEN_MIN &&
    (user.arena_votes_received ?? 0) >= POOL_VOTES_RECEIVED_MIN
  );
}

module.exports = { shouldBeInPool, POOL_COMPLETUDE_MIN, POOL_VOTES_GIVEN_MIN, POOL_VOTES_RECEIVED_MIN };
