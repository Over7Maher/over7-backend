const {
  isArenaValidated,
  setArenaValidated,
  invalidateArenaValidatedCache,
} = require('../arenaValidatedCache');

const TEST_KEYS = ['user-1', 'user-2', 'user-3', 'ghost-user'];

describe('arenaValidatedCache', () => {
  let mockPool;

  beforeEach(() => {
    mockPool = { query: jest.fn() };
    // Module-level singleton — clear test keys to prevent cross-test bleed.
    for (const key of TEST_KEYS) invalidateArenaValidatedCache(key);
  });

  test('Cache miss → DB query executed + cache populated', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ arena_validated: true }] });

    const result = await isArenaValidated('user-1', mockPool);

    expect(result).toBe(true);
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    expect(mockPool.query).toHaveBeenCalledWith(
      'SELECT arena_validated FROM users WHERE id = $1',
      ['user-1'],
    );
  });

  test('Cache hit → DB skipped on second read', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ arena_validated: true }] });

    const r1 = await isArenaValidated('user-1', mockPool);
    expect(r1).toBe(true);

    mockPool.query.mockClear();

    const r2 = await isArenaValidated('user-1', mockPool);
    expect(r2).toBe(true);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  test('User does not exist → returns null, cache NOT populated', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const result = await isArenaValidated('ghost-user', mockPool);
    expect(result).toBeNull();

    // Next read should still hit DB (no negative cache for missing rows)
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const result2 = await isArenaValidated('ghost-user', mockPool);
    expect(result2).toBeNull();
    expect(mockPool.query).toHaveBeenCalledTimes(2);
  });

  test('setArenaValidated pre-warms cache to true → next read = 0 DB hit', async () => {
    setArenaValidated('user-2');

    const result = await isArenaValidated('user-2', mockPool);

    expect(result).toBe(true);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  test('invalidateArenaValidatedCache forces next read to hit DB', async () => {
    setArenaValidated('user-3');

    invalidateArenaValidatedCache('user-3');

    mockPool.query.mockResolvedValueOnce({ rows: [{ arena_validated: true }] });
    const result = await isArenaValidated('user-3', mockPool);

    expect(result).toBe(true);
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  test('FALSE values are cached too (not just TRUE)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ arena_validated: false }] });

    const r1 = await isArenaValidated('user-1', mockPool);
    expect(r1).toBe(false);

    mockPool.query.mockClear();

    const r2 = await isArenaValidated('user-1', mockPool);
    expect(r2).toBe(false);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  test('Cache values are isolated per userId', async () => {
    setArenaValidated('user-1');
    mockPool.query.mockResolvedValueOnce({ rows: [{ arena_validated: false }] });

    const r1 = await isArenaValidated('user-1', mockPool); // cache hit, true
    const r2 = await isArenaValidated('user-2', mockPool); // miss, false from DB

    expect(r1).toBe(true);
    expect(r2).toBe(false);
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    expect(mockPool.query).toHaveBeenCalledWith(expect.any(String), ['user-2']);
  });
});
