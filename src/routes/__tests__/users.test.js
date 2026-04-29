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

const request = require('supertest');
const app  = require('../../app');
const pool = require('../../db/pool');

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
