const mockVerifyIdToken = jest.fn();
const mockIsArenaValidated = jest.fn();

jest.mock('../../services/firebaseAdmin', () => () => ({
  auth: () => ({ verifyIdToken: mockVerifyIdToken }),
}));
jest.mock('../../db/pool', () => ({
  query:   jest.fn(),
  connect: jest.fn(),
}));
jest.mock('../../services/socket', () => () => ({ emit: jest.fn(), to: () => ({ emit: jest.fn() }) }));
jest.mock('../../jobs/scheduler', () => ({ scheduleJobs: jest.fn() }));
jest.mock('../../services/poolTransition', () => ({ handlePoolTransition: jest.fn().mockResolvedValue() }));
jest.mock('../../services/arenaValidation', () => ({ handleArenaValidation: jest.fn().mockResolvedValue() }));
jest.mock('../../services/arenaValidatedCache', () => ({
  isArenaValidated:           (...args) => mockIsArenaValidated(...args),
  setArenaValidated:          jest.fn(),
  invalidateArenaValidatedCache: jest.fn(),
}));

const request = require('supertest');
const app  = require('../../app');
const pool = require('../../db/pool');
const { handlePoolTransition } = require('../../services/poolTransition');
const { handleArenaValidation } = require('../../services/arenaValidation');

// Real UUID v4 strings — required because POST /api/arena/vote validates
// voted_id with express-validator's isUUID(), which rejects all-numeric
// non-RFC-4122 fixtures (e.g. '22222222-...').
const VOTER_ID = '550e8400-e29b-41d4-a716-446655440000';
const VOTED_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const ACTIVE_USER = {
  id:           VOTER_ID,
  firebase_uid: 'fbuid-voter',
  email:        'voter@example.com',
  name:         'Voter',
  is_active:    true,
  seeking:      'all',
};

function mockAuthOk(overrides = {}) {
  mockVerifyIdToken.mockResolvedValueOnce({ uid: ACTIVE_USER.firebase_uid });
  pool.query.mockResolvedValueOnce({ rows: [{ ...ACTIVE_USER, ...overrides }] });
}

// Returns a mocked DB client whose .query is queued via mockResolvedValueOnce(...)
// in test order. .release() is also a jest.fn so we can assert it ran.
function mockClient() {
  const client = {
    query:   jest.fn(),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValueOnce(client);
  return client;
}

describe('GET /api/arena/profiles', () => {
  beforeEach(() => jest.resetAllMocks());

  test('Missing Authorization → 401', async () => {
    const res = await request(app).get('/api/arena/profiles');
    expect(res.status).toBe(401);
  });

  test('Auth OK + 5 candidates → 200, no_more_profiles=false', async () => {
    mockAuthOk();
    const profiles = Array.from({ length: 5 }, (_, i) => ({ id: `u${i}`, name: `User${i}` }));
    pool.query.mockResolvedValueOnce({ rows: profiles });

    const res = await request(app)
      .get('/api/arena/profiles')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(5);
    expect(res.body.no_more_profiles).toBe(false);
    expect(res.body.profiles).toHaveLength(5);
  });

  test('Auth OK + 0 candidates → 200, no_more_profiles=true', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/api/arena/profiles')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.no_more_profiles).toBe(true);
  });

  test('seeking="male" → SQL gets "male" gender filter', async () => {
    mockAuthOk({ seeking: 'male' });
    pool.query.mockResolvedValueOnce({ rows: [] });

    await request(app)
      .get('/api/arena/profiles')
      .set('Authorization', 'Bearer valid-token');

    expect(pool.query.mock.calls[1][1][2]).toBe('male');
  });

  test('seeking="all" → SQL gets null gender filter (no filter)', async () => {
    mockAuthOk({ seeking: 'all' });
    pool.query.mockResolvedValueOnce({ rows: [] });

    await request(app)
      .get('/api/arena/profiles')
      .set('Authorization', 'Bearer valid-token');

    expect(pool.query.mock.calls[1][1][2]).toBeNull();
  });
});

describe('POST /api/arena/vote', () => {
  beforeEach(() => jest.resetAllMocks());

  test('voted_id not a UUID → 422', async () => {
    mockAuthOk();
    const res = await request(app)
      .post('/api/arena/vote')
      .set('Authorization', 'Bearer valid-token')
      .send({ voted_id: 'not-a-uuid', rating: 5 });

    expect(res.status).toBe(422);
  });

  test('rating out of [1,10] → 422', async () => {
    mockAuthOk();
    const res = await request(app)
      .post('/api/arena/vote')
      .set('Authorization', 'Bearer valid-token')
      .send({ voted_id: VOTED_ID, rating: 11 });

    expect(res.status).toBe(422);
  });

  test('Self-vote (voted_id == voter_id) → 400', async () => {
    mockAuthOk();
    const res = await request(app)
      .post('/api/arena/vote')
      .set('Authorization', 'Bearer valid-token')
      .send({ voted_id: ACTIVE_USER.id, rating: 8 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/own profile/i);
  });

  test('Voted user not found (cache returns null) → 404', async () => {
    mockAuthOk();
    mockIsArenaValidated.mockResolvedValueOnce(null);

    const res = await request(app)
      .post('/api/arena/vote')
      .set('Authorization', 'Bearer valid-token')
      .send({ voted_id: VOTED_ID, rating: 8 });

    expect(res.status).toBe(404);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('Voted user already validated → 200 skipped (no transaction)', async () => {
    mockAuthOk();
    mockIsArenaValidated.mockResolvedValueOnce(true);
    // Tiny SELECT for the display fields (arena_votes_received, avg_rating)
    pool.query.mockResolvedValueOnce({
      rows: [{ arena_votes_received: 42, avg_rating: '8.50' }],
    });

    const res = await request(app)
      .post('/api/arena/vote')
      .set('Authorization', 'Bearer valid-token')
      .send({ voted_id: VOTED_ID, rating: 8 });

    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(true);
    expect(res.body.reason).toBe('voted_user_validated');
    expect(res.body.new_avg_rating).toBe(8.5);
    expect(res.body.new_votes_received).toBe(42);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('Nominal vote → 201, transaction committed, side effects fired', async () => {
    mockAuthOk();
    mockIsArenaValidated.mockResolvedValueOnce(false);
    const client = mockClient();

    // Sequence of client.query() calls in arena.js:
    client.query
      .mockResolvedValueOnce({})                                              // 1. BEGIN
      .mockResolvedValueOnce({})                                              // 2. INSERT arena_votes
      .mockResolvedValueOnce({ rows: [{ is_in_pool: false }] })               // 3. SELECT voter is_in_pool
      .mockResolvedValueOnce({ rows: [{ arena_votes_given: 5, arena_votes_received: 0, avg_rating: null, completude_pct: 80 }] })  // 4. UPDATE voter votes_given RETURNING
      .mockResolvedValueOnce({})                                              // 5. UPDATE voter is_in_pool
      .mockResolvedValueOnce({ rows: [{ is_in_pool: false, arena_validated: false }] })  // 6. SELECT voted before
      .mockResolvedValueOnce({})                                              // 7. UPDATE avg_rating
      .mockResolvedValueOnce({ rows: [{ completude_pct: 90, arena_votes_given: 12, arena_votes_received: 7, avg_rating: '7.50' }] })  // 8. UPDATE voted votes_received RETURNING
      .mockResolvedValueOnce({})                                              // 9. UPDATE voted is_in_pool
      .mockResolvedValueOnce({});                                             // 10. COMMIT

    const res = await request(app)
      .post('/api/arena/vote')
      .set('Authorization', 'Bearer valid-token')
      .send({ voted_id: VOTED_ID, rating: 8 });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.votes_given).toBe(5);
    expect(res.body.remaining_votes).toBe(15); // VOTES_REQUIRED=20, given=5

    // Transaction control flow.
    expect(client.query.mock.calls[0][0]).toBe('BEGIN');
    expect(client.query.mock.calls[9][0]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);

    // INSERT received the right tuple.
    const insertSql = client.query.mock.calls[1][0];
    const insertArgs = client.query.mock.calls[1][1];
    expect(insertSql).toMatch(/INSERT INTO arena_votes/);
    expect(insertArgs).toEqual([ACTIVE_USER.id, VOTED_ID, 8]);

    // avg_rating UPDATE has the defense-in-depth guard.
    const avgUpdateSql = client.query.mock.calls[6][0];
    expect(avgUpdateSql).toMatch(/SET avg_rating/);
    expect(avgUpdateSql).toMatch(/AND arena_validated IS NOT TRUE/);

    // Side effects invoked once for voter and once for voted.
    expect(handlePoolTransition).toHaveBeenCalledTimes(2);
    expect(handleArenaValidation).toHaveBeenCalledTimes(1);
    expect(handleArenaValidation).toHaveBeenCalledWith(expect.objectContaining({
      userId:        VOTED_ID,
      wasValidated:  false,
      votesReceived: 7,
      avgRating:     7.5,
    }));
  });

  test('Duplicate vote (PG 23505 unique violation) → 409 + ROLLBACK', async () => {
    mockAuthOk();
    mockIsArenaValidated.mockResolvedValueOnce(false);
    const client = mockClient();

    const dupErr = Object.assign(new Error('duplicate key'), { code: '23505' });
    client.query
      .mockResolvedValueOnce({})              // BEGIN
      .mockRejectedValueOnce(dupErr)          // INSERT throws
      .mockResolvedValueOnce({});             // ROLLBACK

    const res = await request(app)
      .post('/api/arena/vote')
      .set('Authorization', 'Bearer valid-token')
      .send({ voted_id: VOTED_ID, rating: 8 });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already voted/i);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(handlePoolTransition).not.toHaveBeenCalled();
  });

  test('Voted user FK violation (PG 23503, race delete) → 404 + ROLLBACK', async () => {
    mockAuthOk();
    mockIsArenaValidated.mockResolvedValueOnce(false);
    const client = mockClient();

    const fkErr = Object.assign(new Error('FK violation'), { code: '23503' });
    client.query
      .mockResolvedValueOnce({})              // BEGIN
      .mockRejectedValueOnce(fkErr)           // INSERT throws
      .mockResolvedValueOnce({});             // ROLLBACK

    const res = await request(app)
      .post('/api/arena/vote')
      .set('Authorization', 'Bearer valid-token')
      .send({ voted_id: VOTED_ID, rating: 8 });

    expect(res.status).toBe(404);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/arena/my-stats', () => {
  beforeEach(() => jest.resetAllMocks());

  test('Auth OK + user found → 200 with stats', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({
      rows: [{
        votes_given:     7,
        is_in_pool:      true,
        avg_rating:      '6.80',
        votes_received:  12,
        remaining_votes: 13,
      }],
    });

    const res = await request(app)
      .get('/api/arena/my-stats')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      votes_given:     7,
      is_in_pool:      true,
      avg_rating:      '6.80',
      votes_received:  12,
      remaining_votes: 13,
    });
  });

  test('User row missing in DB → 404', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/api/arena/my-stats')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(404);
  });
});
