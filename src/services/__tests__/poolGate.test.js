const {
  shouldBeInPool,
  POOL_COMPLETUDE_MIN,
  POOL_VOTES_GIVEN_MIN,
  POOL_VOTES_RECEIVED_MIN,
  POOL_AVG_RATING_MIN,
} = require('../poolGate');

describe('Threshold constants', () => {
  test('POOL_COMPLETUDE_MIN === 70', () => {
    expect(POOL_COMPLETUDE_MIN).toBe(70);
  });

  test('POOL_VOTES_GIVEN_MIN === 20', () => {
    expect(POOL_VOTES_GIVEN_MIN).toBe(20);
  });

  test('POOL_VOTES_RECEIVED_MIN === 20', () => {
    expect(POOL_VOTES_RECEIVED_MIN).toBe(20);
  });

  test('POOL_AVG_RATING_MIN === 7', () => {
    expect(POOL_AVG_RATING_MIN).toBe(7);
  });
});

describe('shouldBeInPool', () => {
  function userAtThreshold() {
    return {
      arena_votes_given:    20,
      arena_votes_received: 20,
      avg_rating:           7,
      completude_pct:       70,
    };
  }

  test('All thresholds met (exactly) → true', () => {
    expect(shouldBeInPool(userAtThreshold())).toBe(true);
  });

  test('All thresholds well above → true', () => {
    expect(shouldBeInPool({
      arena_votes_given:    50,
      arena_votes_received: 100,
      avg_rating:           9.2,
      completude_pct:       95,
    })).toBe(true);
  });

  test('arena_votes_given below threshold → false', () => {
    const u = userAtThreshold();
    u.arena_votes_given = 19;
    expect(shouldBeInPool(u)).toBe(false);
  });

  test('arena_votes_received below threshold → false', () => {
    const u = userAtThreshold();
    u.arena_votes_received = 19;
    expect(shouldBeInPool(u)).toBe(false);
  });

  test('avg_rating below threshold → false', () => {
    const u = userAtThreshold();
    u.avg_rating = 6.99;
    expect(shouldBeInPool(u)).toBe(false);
  });

  test('completude_pct below threshold → false', () => {
    const u = userAtThreshold();
    u.completude_pct = 69;
    expect(shouldBeInPool(u)).toBe(false);
  });

  test('Empty user object → false (all fields nullish, treated as 0)', () => {
    expect(() => shouldBeInPool({})).not.toThrow();
    expect(shouldBeInPool({})).toBe(false);
  });

  test('Explicit nulls → false (no NPE via ?? 0)', () => {
    expect(() => shouldBeInPool({
      arena_votes_given:    null,
      arena_votes_received: null,
      avg_rating:           null,
      completude_pct:       null,
    })).not.toThrow();
    expect(shouldBeInPool({
      arena_votes_given:    null,
      arena_votes_received: null,
      avg_rating:           null,
      completude_pct:       null,
    })).toBe(false);
  });
});
