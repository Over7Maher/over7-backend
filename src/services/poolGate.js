const POOL_COMPLETUDE_MIN = 70;
const POOL_VOTES_GIVEN_MIN = 20;
const POOL_VOTES_RECEIVED_MIN = 20;
const POOL_AVG_RATING_MIN = 7;

/**
 * Returns true if the user satisfies all conditions to enter the discovery pool:
 * has cast >= 20 arena votes, received >= 20, avg_rating >= 7, completude >= 70%.
 */
function shouldBeInPool(user) {
  return (
    (user.arena_votes_given ?? 0) >= POOL_VOTES_GIVEN_MIN &&
    (user.arena_votes_received ?? 0) >= POOL_VOTES_RECEIVED_MIN &&
    (user.avg_rating ?? 0) >= POOL_AVG_RATING_MIN &&
    (user.completude_pct ?? 0) >= POOL_COMPLETUDE_MIN
  );
}

module.exports = { shouldBeInPool, POOL_COMPLETUDE_MIN, POOL_VOTES_GIVEN_MIN, POOL_VOTES_RECEIVED_MIN, POOL_AVG_RATING_MIN };
