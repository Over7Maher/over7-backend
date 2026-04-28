jest.mock('../../db/pool', () => ({
  query: jest.fn(),
}));

const pool = require('../../db/pool');
const { handlePoolTransition } = require('../poolTransition');
const { mockIo } = require('./__helpers__/mockIo');

describe('handlePoolTransition', () => {
  let io;

  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockResolvedValue({ rows: [] });
    io = mockIo();
  });

  test('false → false : no-op (no DB, no socket)', async () => {
    await handlePoolTransition({
      io, userId: 'user-123', wasInPool: false, isInPool: false, completudePct: 50,
    });
    expect(pool.query).not.toHaveBeenCalled();
    expect(io.to).not.toHaveBeenCalled();
    expect(io.emit).not.toHaveBeenCalled();
  });

  test('true → true : no-op', async () => {
    await handlePoolTransition({
      io, userId: 'user-123', wasInPool: true, isInPool: true, completudePct: 80,
    });
    expect(pool.query).not.toHaveBeenCalled();
    expect(io.to).not.toHaveBeenCalled();
    expect(io.emit).not.toHaveBeenCalled();
  });

  test('Entry false → true : UPDATE + socket pool_unlocked (no payload)', async () => {
    await handlePoolTransition({
      io, userId: 'user-123', wasInPool: false, isInPool: true, completudePct: 80,
    });

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('pool_unlocked_pending');
    expect(sql).toContain('pool_unlocked_at');
    expect(params).toEqual(['user-123']);

    expect(io.to).toHaveBeenCalledWith('user:user-123');
    expect(io.emit).toHaveBeenCalledWith('pool_unlocked');
  });

  test('Entry sets has_been_in_pool_ever=TRUE (cross-device new vs kicked flag)', async () => {
    await handlePoolTransition({
      io, userId: 'user-123', wasInPool: false, isInPool: true, completudePct: 80,
    });
    const sql = pool.query.mock.calls[0][0];
    expect(sql).toContain('has_been_in_pool_ever');
    expect(sql).toContain('TRUE');
  });

  test('Entry clears stale pool_exit_reason and pool_exit_pending', async () => {
    await handlePoolTransition({
      io, userId: 'user-123', wasInPool: false, isInPool: true, completudePct: 80,
    });
    const sql = pool.query.mock.calls[0][0];
    expect(sql).toContain('pool_exit_pending     = FALSE');
    expect(sql).toContain('pool_exit_reason      = NULL');
  });

  test('Exit true → false with completudePct < 70 : reason=completude_below_threshold', async () => {
    await handlePoolTransition({
      io, userId: 'user-123', wasInPool: true, isInPool: false, completudePct: 60,
    });

    expect(io.to).toHaveBeenCalledWith('user:user-123');
    expect(io.emit).toHaveBeenCalledWith('pool_lost', {
      reason:         'completude_below_threshold',
      completude_pct: 60,
    });

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('pool_exited_at');
    expect(sql).toContain('pool_exit_pending');
    expect(params).toEqual(['user-123', 'completude_below_threshold']);
  });

  test('Exit true → false with completudePct >= 70 : reason=rating_below_threshold', async () => {
    await handlePoolTransition({
      io, userId: 'user-123', wasInPool: true, isInPool: false, completudePct: 75,
    });

    expect(io.emit).toHaveBeenCalledWith('pool_lost', {
      reason:         'rating_below_threshold',
      completude_pct: 75,
    });

    const params = pool.query.mock.calls[0][1];
    expect(params).toEqual(['user-123', 'rating_below_threshold']);
  });

  test('Exit at exact threshold completudePct=70 : reason=rating_below_threshold (>= 70)', async () => {
    await handlePoolTransition({
      io, userId: 'user-123', wasInPool: true, isInPool: false, completudePct: 70,
    });
    expect(io.emit).toHaveBeenCalledWith('pool_lost', {
      reason:         'rating_below_threshold',
      completude_pct: 70,
    });
  });

  test('io = undefined → does not crash, DB UPDATE still happens (entry)', async () => {
    await expect(
      handlePoolTransition({
        io: undefined, userId: 'user-123', wasInPool: false, isInPool: true, completudePct: 80,
      })
    ).resolves.not.toThrow();
    expect(pool.query).toHaveBeenCalled();
  });

  test('io = undefined → does not crash, DB UPDATE still happens (exit)', async () => {
    await expect(
      handlePoolTransition({
        io: undefined, userId: 'user-123', wasInPool: true, isInPool: false, completudePct: 60,
      })
    ).resolves.not.toThrow();
    expect(pool.query).toHaveBeenCalled();
  });
});
