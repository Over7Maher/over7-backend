const mockVerifyIdToken = jest.fn();

jest.mock('../../services/firebaseAdmin', () => () => ({
  auth: () => ({ verifyIdToken: mockVerifyIdToken }),
}));
jest.mock('../../db/pool', () => ({
  query:   jest.fn(),
  connect: jest.fn(),
}));
jest.mock('../../services/socket', () => () => ({
  to: () => ({ emit: jest.fn() }),
}));
jest.mock('../../jobs/scheduler', () => ({ scheduleJobs: jest.fn() }));

const request = require('supertest');
const app  = require('../../app');
const pool = require('../../db/pool');

const USER_ID = '550e8400-e29b-41d4-a716-446655440000';

// Default user must satisfy GET /api/discover/profiles preconditions:
//   - is_in_pool = TRUE  → otherwise 403
//   - latitude / longitude not null → otherwise 400
const POOL_USER = {
  id:           USER_ID,
  firebase_uid: 'fbuid-discover',
  email:        'me@example.com',
  name:         'Me',
  is_active:    true,
  is_in_pool:   true,
  latitude:     48.85,
  longitude:    2.30,
  seeking:      'female',
  age_min:      25,
  age_max:      35,
  distance_max: 50,
  tags:         ['music', 'travel'],
  relation_type: 'longterm',
  gender:       'male',
};

function mockAuthOk(overrides = {}) {
  mockVerifyIdToken.mockResolvedValueOnce({ uid: POOL_USER.firebase_uid });
  pool.query.mockResolvedValueOnce({ rows: [{ ...POOL_USER, ...overrides }] });
}

describe('GET /api/discover/profiles', () => {
  beforeEach(() => jest.resetAllMocks());

  test('Missing Authorization → 401', async () => {
    const res = await request(app).get('/api/discover/profiles');
    expect(res.status).toBe(401);
  });

  test('User not in pool → 403', async () => {
    mockAuthOk({ is_in_pool: false });
    const res = await request(app)
      .get('/api/discover/profiles')
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/pool access/i);
  });

  test('Missing latitude/longitude → 400', async () => {
    mockAuthOk({ latitude: null, longitude: null });
    const res = await request(app)
      .get('/api/discover/profiles')
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/location/i);
  });

  test('limit out of range → 422', async () => {
    mockAuthOk();
    const res = await request(app)
      .get('/api/discover/profiles?limit=999')
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(422);
  });

  test('Negative offset → 422', async () => {
    mockAuthOk();
    const res = await request(app)
      .get('/api/discover/profiles?offset=-1')
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(422);
  });

  test('Auth OK + 3 candidates → 200 with profiles + count + pagination meta', async () => {
    mockAuthOk();
    const candidates = [
      { id: 'c1', name: 'A', score: 12.5 },
      { id: 'c2', name: 'B', score: 10.0 },
      { id: 'c3', name: 'C', score:  9.8 },
    ];
    pool.query.mockResolvedValueOnce({ rows: candidates });

    const res = await request(app)
      .get('/api/discover/profiles')
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body.profiles).toEqual(candidates);
    expect(res.body.count).toBe(3);
    expect(res.body.offset).toBe(0);
    expect(res.body.no_more_profiles).toBe(true); // 3 < default limit 10
  });

  test('Empty result → 200 with no_more_profiles=true', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/api/discover/profiles')
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.no_more_profiles).toBe(true);
  });

  test('No query params → falls back to user preferences (gender/age/distance)', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rows: [] });

    await request(app)
      .get('/api/discover/profiles')
      .set('Authorization', 'Bearer t');

    // Param positions in the discover SQL — derived from arena.js source:
    //   $1 me.id, $2 limit, $3 offset, $4 myTags, $5 myRelType,
    //   $6 genderFilter, $7 ageMin, $8 ageMax, $9 lat, $10 lng, $11 distMax, ...
    const params = pool.query.mock.calls[1][1];
    expect(params[0]).toBe(USER_ID);
    expect(params[1]).toBe(10);   // default limit
    expect(params[2]).toBe(0);    // default offset
    expect(params[5]).toBe('female'); // genderFilter from me.seeking
    expect(params[6]).toBe(25);   // ageMin from me.age_min
    expect(params[7]).toBe(35);   // ageMax from me.age_max
    expect(params[10]).toBe(50);  // distMax from me.distance_max
  });

  test('Query params override user prefs (gender, age_min, age_max, distance_max, limit)', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rows: [] });

    await request(app)
      .get('/api/discover/profiles?gender=male&age_min=30&age_max=40&distance_max=100&limit=20')
      .set('Authorization', 'Bearer t');

    const params = pool.query.mock.calls[1][1];
    expect(params[1]).toBe(20);
    expect(params[5]).toBe('male');
    expect(params[6]).toBe(30);
    expect(params[7]).toBe(40);
    expect(params[10]).toBe(100);
  });

  test('seeking="all" → genderFilter=null (no gender filtering)', async () => {
    mockAuthOk({ seeking: 'all' });
    pool.query.mockResolvedValueOnce({ rows: [] });

    await request(app)
      .get('/api/discover/profiles')
      .set('Authorization', 'Bearer t');

    expect(pool.query.mock.calls[1][1][5]).toBeNull();
  });
});
