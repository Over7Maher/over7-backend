jest.mock('../../db/pool', () => ({
  query: jest.fn(),
}));
jest.mock('../arenaValidatedCache', () => ({
  setArenaValidated: jest.fn(),
}));
jest.mock('../push', () => ({
  sendPushToUser: jest.fn(),
}));

const pool = require('../../db/pool');
const { setArenaValidated } = require('../arenaValidatedCache');
const { sendPushToUser } = require('../push');
const { handleArenaValidation } = require('../arenaValidation');
const { mockIo } = require('./__helpers__/mockIo');

describe('handleArenaValidation', () => {
  let io;

  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockResolvedValue({ rows: [] });
    io = mockIo();
  });

  describe('early returns (no side effects)', () => {
    test('wasValidated=true → no-op', async () => {
      await handleArenaValidation({
        io, userId: 'user-123',
        wasValidated: true, votesReceived: 25, avgRating: 8.0,
      });
      expect(pool.query).not.toHaveBeenCalled();
      expect(setArenaValidated).not.toHaveBeenCalled();
      expect(sendPushToUser).not.toHaveBeenCalled();
      expect(io.to).not.toHaveBeenCalled();
    });

    test('votesReceived < 20 → no-op', async () => {
      await handleArenaValidation({
        io, userId: 'user-123',
        wasValidated: false, votesReceived: 19, avgRating: 8.0,
      });
      expect(pool.query).not.toHaveBeenCalled();
      expect(setArenaValidated).not.toHaveBeenCalled();
      expect(sendPushToUser).not.toHaveBeenCalled();
    });

    test('avgRating null → no-op', async () => {
      await handleArenaValidation({
        io, userId: 'user-123',
        wasValidated: false, votesReceived: 25, avgRating: null,
      });
      expect(pool.query).not.toHaveBeenCalled();
    });

    test('avgRating undefined → no-op (== null catches both)', async () => {
      await handleArenaValidation({
        io, userId: 'user-123',
        wasValidated: false, votesReceived: 25, avgRating: undefined,
      });
      expect(pool.query).not.toHaveBeenCalled();
    });

    test('avgRating < 7 → no-op', async () => {
      await handleArenaValidation({
        io, userId: 'user-123',
        wasValidated: false, votesReceived: 25, avgRating: 6.99,
      });
      expect(pool.query).not.toHaveBeenCalled();
    });
  });

  describe('full validation transition', () => {
    test('all criteria met → UPDATE + cache pre-warm + socket + push', async () => {
      await handleArenaValidation({
        io, userId: 'user-123',
        wasValidated: false, votesReceived: 25, avgRating: 8.0,
      });

      // 1 — UPDATE arena_validated=TRUE
      expect(pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toContain('arena_validated');
      expect(sql).toContain('TRUE');
      expect(sql).toContain('arena_validated_pending');
      expect(sql).toContain('COALESCE(arena_validated_at, NOW())');
      expect(params).toEqual(['user-123']);

      // 2 — Cache pre-warm
      expect(setArenaValidated).toHaveBeenCalledWith('user-123');
      expect(setArenaValidated).toHaveBeenCalledTimes(1);

      // 3 — Socket emit
      expect(io.to).toHaveBeenCalledWith('user:user-123');
      expect(io.emit).toHaveBeenCalledWith('arena_validated', {
        avg_rating:     8.0,
        votes_received: 25,
      });

      // 4 — Push notification (opt-out-able category)
      expect(sendPushToUser).toHaveBeenCalledTimes(1);
      const pushCall = sendPushToUser.mock.calls[0];
      expect(pushCall[0]).toBe('user-123');                    // userId
      expect(typeof pushCall[1]).toBe('string');               // title
      expect(typeof pushCall[2]).toBe('string');               // body
      expect(pushCall[3]).toMatchObject({                      // data
        type:           'arena_validated',
        avg_rating:     8.0,
        votes_received: 25,
      });
      expect(pushCall[4]).toBe('arena_milestone');             // category
    });

    test('exact thresholds (votesReceived=20, avgRating=7.0) → validation OK', async () => {
      await handleArenaValidation({
        io, userId: 'user-123',
        wasValidated: false, votesReceived: 20, avgRating: 7.0,
      });
      expect(pool.query).toHaveBeenCalled();
      expect(setArenaValidated).toHaveBeenCalledWith('user-123');
      expect(io.emit).toHaveBeenCalledWith('arena_validated', {
        avg_rating:     7.0,
        votes_received: 20,
      });
      expect(sendPushToUser).toHaveBeenCalled();
    });

    test('io = undefined → does not crash, DB + cache + push still happen', async () => {
      await expect(
        handleArenaValidation({
          io: undefined, userId: 'user-123',
          wasValidated: false, votesReceived: 25, avgRating: 8.0,
        })
      ).resolves.not.toThrow();

      expect(pool.query).toHaveBeenCalled();
      expect(setArenaValidated).toHaveBeenCalledWith('user-123');
      expect(sendPushToUser).toHaveBeenCalled();
    });
  });
});
