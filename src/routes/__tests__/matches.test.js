const mockVerifyIdToken = jest.fn();
const mockEmitToRoom    = jest.fn();

jest.mock('../../services/firebaseAdmin', () => () => ({
  auth: () => ({ verifyIdToken: mockVerifyIdToken }),
}));
jest.mock('../../db/pool', () => ({
  query:   jest.fn(),
  connect: jest.fn(),
}));
jest.mock('../../services/socket', () => () => ({
  to: (room) => ({ emit: (event, payload) => mockEmitToRoom(room, event, payload) }),
}));
jest.mock('../../jobs/scheduler', () => ({ scheduleJobs: jest.fn() }));

const request = require('supertest');
const app  = require('../../app');
const pool = require('../../db/pool');

const ME_ID    = '550e8400-e29b-41d4-a716-446655440000';
const OTHER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const MATCH_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

const ACTIVE_USER = {
  id:           ME_ID,
  firebase_uid: 'fbuid-me',
  email:        'me@example.com',
  name:         'Me',
  is_active:    true,
  latitude:     48.85,
  longitude:    2.30,
};

function mockAuthOk(overrides = {}) {
  mockVerifyIdToken.mockResolvedValueOnce({ uid: ACTIVE_USER.firebase_uid });
  pool.query.mockResolvedValueOnce({ rows: [{ ...ACTIVE_USER, ...overrides }] });
}

describe('GET /api/matches', () => {
  beforeEach(() => jest.resetAllMocks());

  test('Missing Authorization → 401', async () => {
    const res = await request(app).get('/api/matches');
    expect(res.status).toBe(401);
  });

  test('Auth OK + 2 matches → 200 with rows array', async () => {
    mockAuthOk();
    const matches = [
      { match_id: 'm1', other_id: OTHER_ID, other_name: 'Alice', unread_count: 2 },
      { match_id: 'm2', other_id: 'u2',     other_name: 'Bob',   unread_count: 0 },
    ];
    pool.query.mockResolvedValueOnce({ rows: matches });

    const res = await request(app)
      .get('/api/matches')
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(matches);
  });

  test('Auth OK + 0 matches → 200 with empty array', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/api/matches')
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('GET /api/matches/:id', () => {
  beforeEach(() => jest.resetAllMocks());

  test('id not a UUID → 422', async () => {
    mockAuthOk();
    const res = await request(app)
      .get('/api/matches/not-a-uuid')
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(422);
  });

  test('Auth OK + match found → 200 with match payload', async () => {
    mockAuthOk();
    const matchRow = {
      match_id:   MATCH_ID,
      other_id:   OTHER_ID,
      other_name: 'Alice',
      other_bio:  'Hello',
    };
    pool.query.mockResolvedValueOnce({ rows: [matchRow] });

    const res = await request(app)
      .get(`/api/matches/${MATCH_ID}`)
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(matchRow);
  });

  test('Match not found OR user not member → 404 (anti-leak: same response either way)', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get(`/api/matches/${MATCH_ID}`)
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found|access denied/i);

    // Membership guard is enforced in the SQL itself (WHERE m.id = $2 AND
    // (user1_id = $1 OR user2_id = $1)). Verify $1 is the auth user id.
    expect(pool.query.mock.calls[1][1]).toEqual([ME_ID, MATCH_ID]);
  });
});

describe('DELETE /api/matches/:id', () => {
  beforeEach(() => jest.resetAllMocks());

  test('id not a UUID → 422', async () => {
    mockAuthOk();
    const res = await request(app)
      .delete('/api/matches/not-a-uuid')
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(422);
  });

  test('Match not found OR user not member → 404', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const res = await request(app)
      .delete(`/api/matches/${MATCH_ID}`)
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(404);
    expect(mockEmitToRoom).not.toHaveBeenCalled();
  });

  test('Nominal unmatch → 204 + soft-delete + emit match_cancelled to other user', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows:     [{ user1_id: ME_ID, user2_id: OTHER_ID }],
    });

    const res = await request(app)
      .delete(`/api/matches/${MATCH_ID}`)
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(204);

    // Soft-delete SQL: SET is_active = FALSE + member guard.
    const updateSql = pool.query.mock.calls[1][0];
    expect(updateSql).toMatch(/SET\s+is_active\s*=\s*FALSE/);
    expect(updateSql).toMatch(/AND\s+\(user1_id\s*=\s*\$2\s+OR\s+user2_id\s*=\s*\$2\)/);
    expect(updateSql).toMatch(/AND\s+is_active\s*=\s*TRUE/);

    // Other user gets the cancel emit, not the caller.
    expect(mockEmitToRoom).toHaveBeenCalledTimes(1);
    expect(mockEmitToRoom).toHaveBeenCalledWith(`user:${OTHER_ID}`, 'match_cancelled', { match_id: MATCH_ID });
  });

  test('Other-side caller (user2) → emit goes to user1', async () => {
    mockAuthOk();
    // Match returned with user2_id === me means we are user2; the "other" is user1_id.
    pool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows:     [{ user1_id: OTHER_ID, user2_id: ME_ID }],
    });

    await request(app)
      .delete(`/api/matches/${MATCH_ID}`)
      .set('Authorization', 'Bearer t');

    expect(mockEmitToRoom).toHaveBeenCalledWith(`user:${OTHER_ID}`, 'match_cancelled', { match_id: MATCH_ID });
  });
});
