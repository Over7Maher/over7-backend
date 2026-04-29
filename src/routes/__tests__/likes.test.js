const mockVerifyIdToken   = jest.fn();
const mockEmitToRoom      = jest.fn();
const mockSendPushToUser  = jest.fn();

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
jest.mock('../../services/push', () => ({
  sendPushToUser: (...args) => mockSendPushToUser(...args),
}));
jest.mock('../../jobs/scheduler', () => ({ scheduleJobs: jest.fn() }));
jest.mock('../../services/poolTransition', () => ({ handlePoolTransition: jest.fn() }));

const request = require('supertest');
const app  = require('../../app');
const pool = require('../../db/pool');

// Real UUID v4 fixtures (RFC 4122 compliant — required by isUUID validator).
const LIKER_ID = '550e8400-e29b-41d4-a716-446655440000';
const LIKED_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const ACTIVE_USER = {
  id:           LIKER_ID,
  firebase_uid: 'fbuid-liker',
  email:        'liker@example.com',
  name:         'Liker',
  is_active:    true,
  latitude:     48.85,
  longitude:    2.30,
};

function mockAuthOk(overrides = {}) {
  mockVerifyIdToken.mockResolvedValueOnce({ uid: ACTIVE_USER.firebase_uid });
  pool.query.mockResolvedValueOnce({ rows: [{ ...ACTIVE_USER, ...overrides }] });
}

describe('POST /api/likes', () => {
  beforeEach(() => jest.resetAllMocks());

  test('Missing Authorization → 401', async () => {
    const res = await request(app).post('/api/likes').send({ liked_id: LIKED_ID });
    expect(res.status).toBe(401);
  });

  test('liked_id not a UUID → 422', async () => {
    mockAuthOk();
    const res = await request(app)
      .post('/api/likes')
      .set('Authorization', 'Bearer t')
      .send({ liked_id: 'not-a-uuid' });

    expect(res.status).toBe(422);
  });

  test('Self-like (likerId === likedId) → 400', async () => {
    mockAuthOk();
    const res = await request(app)
      .post('/api/likes')
      .set('Authorization', 'Bearer t')
      .send({ liked_id: ACTIVE_USER.id });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot like yourself/i);
  });

  test('New like, no reciprocal → 201, is_match=false, no push', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'like-id', is_speed_date: false, is_new: true }] }); // INSERT like
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });                                          // reciprocal SELECT

    const res = await request(app)
      .post('/api/likes')
      .set('Authorization', 'Bearer t')
      .send({ liked_id: LIKED_ID });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ like_id: 'like-id', is_match: false, is_speed_date: false });
    // socket emits new_like and a single push goes out to the liked user
    expect(mockEmitToRoom).toHaveBeenCalledWith(`user:${LIKED_ID}`, 'new_like', expect.any(Object));
    expect(mockSendPushToUser).toHaveBeenCalledTimes(1);
    expect(mockSendPushToUser).toHaveBeenCalledWith(LIKED_ID, expect.any(String), expect.any(String), expect.any(Object), 'like');
  });

  test('Idempotent like (already existed) → 200 with is_new=false, NO new_like emit', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'like-id', is_speed_date: false, is_new: false }] }); // INSERT ON CONFLICT
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });                                           // reciprocal SELECT

    const res = await request(app)
      .post('/api/likes')
      .set('Authorization', 'Bearer t')
      .send({ liked_id: LIKED_ID });

    expect(res.status).toBe(200);
    expect(res.body.is_match).toBe(false);
    // is_new=false → route does NOT emit new_like or send a push (re-like spam guard)
    expect(mockEmitToRoom).not.toHaveBeenCalled();
    expect(mockSendPushToUser).not.toHaveBeenCalled();
  });

  test('Reciprocal like → match created, 201 + 2 pushes + 2 socket emits', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'like-id',  is_speed_date: false, is_new: true }] });    // INSERT like
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ is_speed_date: false }] });                     // reciprocal exists
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'match-id', is_new: true }] });                          // INSERT match
    pool.query.mockResolvedValueOnce({ rows: [{ name: 'LikedUser' }] });                                     // SELECT liked name

    const res = await request(app)
      .post('/api/likes')
      .set('Authorization', 'Bearer t')
      .send({ liked_id: LIKED_ID });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ like_id: 'like-id', is_match: true, match_id: 'match-id', is_speed_date: false });

    // Both rooms received new_match.
    expect(mockEmitToRoom).toHaveBeenCalledWith(`user:${LIKER_ID}`, 'new_match', expect.objectContaining({ match_id: 'match-id', other_id: LIKED_ID, other_name: 'LikedUser' }));
    expect(mockEmitToRoom).toHaveBeenCalledWith(`user:${LIKED_ID}`, 'new_match', expect.objectContaining({ match_id: 'match-id', other_id: LIKER_ID, other_name: ACTIVE_USER.name }));

    // Push sent to BOTH users (match notif), category='match'.
    expect(mockSendPushToUser).toHaveBeenCalledTimes(2);
    expect(mockSendPushToUser).toHaveBeenCalledWith(LIKER_ID, expect.any(String), expect.any(String), expect.objectContaining({ match_id: 'match-id' }), 'match');
    expect(mockSendPushToUser).toHaveBeenCalledWith(LIKED_ID, expect.any(String), expect.any(String), expect.objectContaining({ match_id: 'match-id' }), 'match');

    // Match INSERT receives both UUIDs (LEAST/GREATEST normalisation lives in SQL — we only check params here).
    const matchInsertArgs = pool.query.mock.calls[3][1];
    expect(matchInsertArgs.slice(0, 2).sort()).toEqual([LIKED_ID, LIKER_ID].sort());
  });
});

describe('PATCH /api/likes/:id/dismiss', () => {
  beforeEach(() => jest.resetAllMocks());

  test('Invalid id format → 400', async () => {
    mockAuthOk();
    const res = await request(app)
      .patch('/api/likes/not-a-uuid/dismiss')
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(400);
  });

  test('Like not found or already dismissed → 404', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const res = await request(app)
      .patch(`/api/likes/${LIKED_ID}/dismiss`)
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(404);
  });

  test('Nominal dismiss → 204 + sets dismissed_at and guards on liked_id', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: LIKED_ID }] });

    const res = await request(app)
      .patch(`/api/likes/${LIKED_ID}/dismiss`)
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(204);
    const updateSql = pool.query.mock.calls[1][0];
    expect(updateSql).toMatch(/SET\s+dismissed_at\s*=\s*NOW\(\)/);
    expect(updateSql).toMatch(/WHERE\s+id\s*=\s*\$1\s+AND\s+liked_id\s*=\s*\$2/);
  });
});

describe('GET /api/likes/received', () => {
  beforeEach(() => jest.resetAllMocks());

  test('Auth OK → 200 with raw rows array', async () => {
    mockAuthOk();
    const rows = [
      { like_id: 'l1', id: 'u1', name: 'A', is_speed_date: false, is_speed_date_alive: false },
      { like_id: 'l2', id: 'u2', name: 'B', is_speed_date: true,  is_speed_date_alive: true  },
    ];
    pool.query.mockResolvedValueOnce({ rows });

    const res = await request(app)
      .get('/api/likes/received')
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(rows);
  });
});

describe('GET /api/likes/sent', () => {
  beforeEach(() => jest.resetAllMocks());

  test('Returns 501 — feature not implemented', async () => {
    mockAuthOk();
    const res = await request(app).get('/api/likes/sent').set('Authorization', 'Bearer t');
    expect(res.status).toBe(501);
  });
});

describe('GET /api/likes/can-super-like', () => {
  beforeEach(() => jest.resetAllMocks());

  test('Available → 200 can_super_like=true, next_available_at=null', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rows: [{ can_super_like: true }] });

    const res = await request(app)
      .get('/api/likes/can-super-like')
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body.can_super_like).toBe(true);
    expect(res.body.next_available_at).toBeNull();
  });

  test('Used today → 200 can_super_like=false, next_available_at set', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rows: [{ can_super_like: false }] });

    const res = await request(app)
      .get('/api/likes/can-super-like')
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body.can_super_like).toBe(false);
    expect(typeof res.body.next_available_at).toBe('string'); // ISO timestamp
  });
});

describe('POST /api/likes/super', () => {
  beforeEach(() => jest.resetAllMocks());

  test('Self super-like → 400', async () => {
    mockAuthOk();
    const res = await request(app)
      .post('/api/likes/super')
      .set('Authorization', 'Bearer t')
      .send({ liked_id: ACTIVE_USER.id });

    expect(res.status).toBe(400);
  });

  test('Quota already used today → 429 + next_available_at', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rows: [{ used_today: true }] });

    const res = await request(app)
      .post('/api/likes/super')
      .set('Authorization', 'Bearer t')
      .send({ liked_id: LIKED_ID });

    expect(res.status).toBe(429);
    expect(res.body.next_available_at).toBeDefined();
  });

  test('Nominal super-like, no reciprocal → 201, is_super=true, push w/ "SUPER liké"', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rows: [{ used_today: false }] });                                  // quota
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'like-id', is_speed_date: false }] });                // INSERT like
    pool.query.mockResolvedValueOnce({});                                                                 // UPDATE last_super_like_at
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });                                          // reciprocal SELECT

    const res = await request(app)
      .post('/api/likes/super')
      .set('Authorization', 'Bearer t')
      .send({ liked_id: LIKED_ID });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ like_id: 'like-id', is_match: false, is_super: true, is_speed_date: false });
    expect(mockSendPushToUser).toHaveBeenCalledTimes(1);
    expect(mockSendPushToUser.mock.calls[0][1]).toMatch(/SUPER/);
  });

  test('Reciprocal super-like → match created, 201 + 2 pushes', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rows: [{ used_today: false }] });                                  // quota
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'like-id', is_speed_date: false }] });                // INSERT like
    pool.query.mockResolvedValueOnce({});                                                                 // UPDATE last_super_like_at
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ is_speed_date: false }] });                  // reciprocal exists
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'match-id', is_new: true }] });                       // INSERT match
    pool.query.mockResolvedValueOnce({ rows: [{ name: 'LikedUser' }] });                                  // SELECT liked name

    const res = await request(app)
      .post('/api/likes/super')
      .set('Authorization', 'Bearer t')
      .send({ liked_id: LIKED_ID });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ like_id: 'like-id', is_match: true, match_id: 'match-id', is_super: true, is_speed_date: false });
    expect(mockSendPushToUser).toHaveBeenCalledTimes(2);
  });
});
