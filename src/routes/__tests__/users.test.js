const mockVerifyIdToken = jest.fn();

jest.mock('../../services/firebaseAdmin', () => () => ({
  auth: () => ({
    verifyIdToken: mockVerifyIdToken,
  }),
}));
jest.mock('../../db/pool', () => ({
  query: jest.fn(),
}));
jest.mock('../../services/socket', () => () => ({ emit: jest.fn(), to: () => ({ emit: jest.fn() }) }));
jest.mock('../../jobs/scheduler', () => ({ scheduleJobs: jest.fn() }));
jest.mock('../../services/poolTransition', () => ({ handlePoolTransition: jest.fn().mockResolvedValue() }));

const request = require('supertest');
const app  = require('../../app');
const pool = require('../../db/pool');
const { handlePoolTransition } = require('../../services/poolTransition');

// Active user row used as the auth-middleware DB result for protected routes.
const ACTIVE_USER = {
  id:           'user-uuid-1',
  firebase_uid: 'fbuid-123',
  email:        'alice@example.com',
  name:         'Alice',
  is_active:    true,
  age_min:      null,
  age_max:      null,
  distance_max: null,
  is_in_pool:   false,
};

function mockAuthOk() {
  mockVerifyIdToken.mockResolvedValueOnce({ uid: ACTIVE_USER.firebase_uid });
  pool.query.mockResolvedValueOnce({ rows: [ACTIVE_USER] });
}

describe('GET /health', () => {
  test('returns 200 with status ok (no auth required)', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.timestamp).toBeDefined();
  });
});

describe('GET /api/users/me', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('Missing Authorization header → 401', async () => {
    const res = await request(app).get('/api/users/me');

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/missing|malformed/i);
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  test('Invalid token (auth/argument-error) → 401 "Invalid token"', async () => {
    const err = Object.assign(new Error('Bad'), { code: 'auth/argument-error' });
    mockVerifyIdToken.mockRejectedValueOnce(err);

    const res = await request(app)
      .get('/api/users/me')
      .set('Authorization', 'Bearer fake-token');

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid/i);
  });

  test('Valid token but user not found in DB → 401', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({ uid: 'fbuid-ghost' });
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/api/users/me')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/not found|inactive/i);
  });

  test('Valid token + active user → 200 with formatted user body', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({ uid: 'fbuid-123' });
    const userRow = {
      id:                   'user-uuid-1',
      firebase_uid:         'fbuid-123',
      email:                'alice@example.com',
      name:                 'Alice',
      is_active:            true,
      completude_pct:       42,
      notification_preferences: { match: true },
      // Other columns left undefined — formatUser tolerates that.
    };
    pool.query.mockResolvedValueOnce({ rows: [userRow] });

    const res = await request(app)
      .get('/api/users/me')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      id:                       'user-uuid-1',
      email:                    'alice@example.com',
      name:                     'Alice',
      completude_pct:           42,
      notification_preferences: { match: true },
    }));
    // formatUser whitelists fields — firebase_uid and is_active must NOT leak.
    expect(res.body).not.toHaveProperty('firebase_uid');
    expect(res.body).not.toHaveProperty('is_active');
  });
});

describe('POST /api/users/register', () => {
  beforeEach(() => jest.clearAllMocks());

  test('Missing firebase_uid → 422 validation error', async () => {
    const res = await request(app).post('/api/users/register').send({});
    expect(res.status).toBe(422);
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('Existing active user → 200 idempotent return (no INSERT)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ ...ACTIVE_USER, name: 'Existing' }] });

    const res = await request(app)
      .post('/api/users/register')
      .send({ firebase_uid: 'fbuid-123', email: 'alice@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Existing');
    expect(pool.query).toHaveBeenCalledTimes(1); // only the SELECT
  });

  test('New user → 201 with formatted body', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });            // SELECT existing → none
    pool.query.mockResolvedValueOnce({                          // INSERT RETURNING *
      rows: [{ ...ACTIVE_USER, id: 'new-id', name: 'NewUser', email: 'new@example.com' }],
    });

    const res = await request(app)
      .post('/api/users/register')
      .send({ firebase_uid: 'newuid', email: 'new@example.com', name: 'NewUser' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(expect.objectContaining({ id: 'new-id', name: 'NewUser' }));
    expect(res.body).not.toHaveProperty('firebase_uid');
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  test('Duplicate email (Postgres 23505) → 409', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const dup = Object.assign(new Error('duplicate key'), { code: '23505' });
    pool.query.mockRejectedValueOnce(dup);

    const res = await request(app)
      .post('/api/users/register')
      .send({ firebase_uid: 'newuid', email: 'taken@example.com' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/email/i);
  });
});

describe('GET /api/users/me/completude', () => {
  beforeEach(() => jest.clearAllMocks());

  test('Missing Authorization → 401', async () => {
    const res = await request(app).get('/api/users/me/completude');
    expect(res.status).toBe(401);
  });

  test('Auth OK → 200 with completude breakdown', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rows: [{ count: 2 }] }); // prompts count

    const res = await request(app)
      .get('/api/users/me/completude')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('pct');
    expect(Array.isArray(res.body.items)).toBe(true);
  });
});

describe('GET /api/users/me/counts', () => {
  beforeEach(() => jest.clearAllMocks());

  test('Auth OK → 200 with likes_received and unread_matches', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rows: [{ cnt: 3 }] });
    pool.query.mockResolvedValueOnce({ rows: [{ cnt: 1 }] });

    const res = await request(app)
      .get('/api/users/me/counts')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ likes_received: 3, unread_matches: 1 });
  });
});

describe('POST /api/users/me/seen-matches', () => {
  beforeEach(() => jest.clearAllMocks());

  test('Missing Authorization → 401', async () => {
    const res = await request(app).post('/api/users/me/seen-matches');
    expect(res.status).toBe(401);
  });

  test('Auth OK → 204 + UPDATE last_seen_matches_at', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(app)
      .post('/api/users/me/seen-matches')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(204);
    const updateCall = pool.query.mock.calls[1][0];
    expect(updateCall).toMatch(/last_seen_matches_at\s*=\s*NOW\(\)/);
  });
});

describe('POST /api/users/me/seen-likes', () => {
  beforeEach(() => jest.clearAllMocks());

  test('Auth OK → 204 + UPDATE last_seen_likes_at', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(app)
      .post('/api/users/me/seen-likes')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(204);
    const updateCall = pool.query.mock.calls[1][0];
    expect(updateCall).toMatch(/last_seen_likes_at\s*=\s*NOW\(\)/);
  });
});

describe('PATCH /api/users/me/push-token', () => {
  beforeEach(() => jest.clearAllMocks());

  test('Empty token → 422', async () => {
    mockAuthOk();
    const res = await request(app)
      .patch('/api/users/me/push-token')
      .set('Authorization', 'Bearer valid-token')
      .send({ token: '   ' });

    expect(res.status).toBe(422);
  });

  test('Token > 200 chars → 422', async () => {
    mockAuthOk();
    const res = await request(app)
      .patch('/api/users/me/push-token')
      .set('Authorization', 'Bearer valid-token')
      .send({ token: 'a'.repeat(201) });

    expect(res.status).toBe(422);
  });

  test('Valid token → 204 + UPDATE push_token', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(app)
      .patch('/api/users/me/push-token')
      .set('Authorization', 'Bearer valid-token')
      .send({ token: 'ExponentPushToken[xxx]' });

    expect(res.status).toBe(204);
    expect(pool.query.mock.calls[1][1]).toEqual(['ExponentPushToken[xxx]', ACTIVE_USER.id]);
  });
});

describe('PATCH /api/users/me/notification-preferences', () => {
  beforeEach(() => jest.clearAllMocks());

  test('Missing preferences object → 400', async () => {
    mockAuthOk();
    const res = await request(app)
      .patch('/api/users/me/notification-preferences')
      .set('Authorization', 'Bearer valid-token')
      .send({});

    expect(res.status).toBe(400);
  });

  test('Only invalid keys/types → 400', async () => {
    mockAuthOk();
    const res = await request(app)
      .patch('/api/users/me/notification-preferences')
      .set('Authorization', 'Bearer valid-token')
      .send({ preferences: { unknown_key: true, match: 'not-a-boolean' } });

    expect(res.status).toBe(400);
  });

  test('Valid + invalid keys mixed → 200, only valid keys persisted', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({
      rows: [{ notification_preferences: { match: false, message: true } }],
    });

    const res = await request(app)
      .patch('/api/users/me/notification-preferences')
      .set('Authorization', 'Bearer valid-token')
      .send({ preferences: { match: false, unknown: true, message: 'nope' } });

    expect(res.status).toBe(200);
    expect(res.body.preferences).toEqual({ match: false, message: true });
    // Only valid filtered key (match) should reach the SQL.
    const filteredJson = JSON.parse(pool.query.mock.calls[1][1][0]);
    expect(filteredJson).toEqual({ match: false });
  });
});

describe('PATCH /api/users/me/location', () => {
  beforeEach(() => jest.clearAllMocks());

  test('Latitude out of range → 422', async () => {
    mockAuthOk();
    const res = await request(app)
      .patch('/api/users/me/location')
      .set('Authorization', 'Bearer valid-token')
      .send({ latitude: 200, longitude: 0 });

    expect(res.status).toBe(422);
  });

  test('Valid coordinates → 204 + rounded to 2 decimals', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(app)
      .patch('/api/users/me/location')
      .set('Authorization', 'Bearer valid-token')
      .send({ latitude: 48.857799, longitude: 2.295123 });

    expect(res.status).toBe(204);
    const params = pool.query.mock.calls[1][1];
    expect(params[0]).toBe(48.86);
    expect(params[1]).toBe(2.30);
  });
});

describe('PATCH /api/users/me', () => {
  beforeEach(() => jest.clearAllMocks());

  test('No valid fields in body → 400', async () => {
    mockAuthOk();
    const res = await request(app)
      .patch('/api/users/me')
      .set('Authorization', 'Bearer valid-token')
      .send({ unknown_column: 'whatever' });

    expect(res.status).toBe(400);
  });

  test('Valid update → 200 and tampered fields (firebase_uid, is_active) ignored', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rows: [{ count: 0 }] }); // prompts count
    pool.query.mockResolvedValueOnce({                            // UPDATE RETURNING *
      rows: [{ ...ACTIVE_USER, name: 'Renamed' }],
    });

    const res = await request(app)
      .patch('/api/users/me')
      .set('Authorization', 'Bearer valid-token')
      .send({
        name:         'Renamed',
        firebase_uid: 'attacker-tries-to-change',
        is_active:    false,
      });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed');

    // The UPDATE statement must NOT contain firebase_uid or is_active in its SET clause.
    const updateSql = pool.query.mock.calls[2][0];
    expect(updateSql).toMatch(/^UPDATE users SET/);
    expect(updateSql).not.toMatch(/firebase_uid\s*=/);
    expect(updateSql).not.toMatch(/is_active\s*=/);

    expect(handlePoolTransition).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/users/me/acknowledge-* (4 routes)', () => {
  beforeEach(() => jest.clearAllMocks());

  const routes = [
    { path: '/api/users/me/acknowledge-pool-unlock',     column: 'pool_unlocked_pending = FALSE' },
    { path: '/api/users/me/acknowledge-pool-exit',       column: 'pool_exit_pending = FALSE' },
    { path: '/api/users/me/acknowledge-arena-validated', column: 'arena_validated_pending = FALSE' },
    { path: '/api/users/me/acknowledge-arena-intro',     column: 'arena_intro_seen = TRUE' },
  ];

  test.each(routes)('POST $path → 204 + correct UPDATE', async ({ path, column }) => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(app)
      .post(path)
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(204);
    const updateSql = pool.query.mock.calls[1][0];
    expect(updateSql).toContain(column);
  });
});

describe('DELETE /api/users/me', () => {
  beforeEach(() => jest.clearAllMocks());

  test('Active user → 204 + soft delete (is_active=FALSE, deleted_at=NOW())', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: ACTIVE_USER.id }] });

    const res = await request(app)
      .delete('/api/users/me')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(204);
    const updateSql = pool.query.mock.calls[1][0];
    expect(updateSql).toMatch(/SET\s+is_active\s*=\s*FALSE/);
    expect(updateSql).toMatch(/deleted_at\s*=\s*NOW\(\)/);
    // Server-side guard: only soft-delete still-active rows.
    expect(updateSql).toMatch(/AND\s+is_active\s*=\s*TRUE/);
  });

  test('Already deleted (rowCount=0) → 404', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const res = await request(app)
      .delete('/api/users/me')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found|already deleted/i);
  });
});
