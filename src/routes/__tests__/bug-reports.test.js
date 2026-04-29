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

const ACTIVE_USER = {
  id:           USER_ID,
  firebase_uid: 'fbuid-bug',
  email:        'me@example.com',
  name:         'Me',
  is_active:    true,
};

function mockAuthOk() {
  mockVerifyIdToken.mockResolvedValueOnce({ uid: ACTIVE_USER.firebase_uid });
  pool.query.mockResolvedValueOnce({ rows: [ACTIVE_USER] });
}

describe('POST /api/bug-reports', () => {
  beforeEach(() => jest.resetAllMocks());

  test('Missing Authorization → 401', async () => {
    const res = await request(app).post('/api/bug-reports').send({ action: 'a', description: 'd' });
    expect(res.status).toBe(401);
  });

  test('Empty action → 422', async () => {
    mockAuthOk();
    const res = await request(app)
      .post('/api/bug-reports')
      .set('Authorization', 'Bearer t')
      .send({ action: '   ', description: 'something broken' });

    expect(res.status).toBe(422);
  });

  test('Empty description → 422', async () => {
    mockAuthOk();
    const res = await request(app)
      .post('/api/bug-reports')
      .set('Authorization', 'Bearer t')
      .send({ action: 'I clicked send', description: '   ' });

    expect(res.status).toBe(422);
  });

  test('description > 2000 chars → 422', async () => {
    mockAuthOk();
    const res = await request(app)
      .post('/api/bug-reports')
      .set('Authorization', 'Bearer t')
      .send({ action: 'I clicked send', description: 'x'.repeat(2001) });

    expect(res.status).toBe(422);
  });

  test('Nominal → 201 + INSERT with user_id from auth (anti-tampering) + nullable optional fields', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'bug-id', created_at: '2026-04-29T12:00:00Z' }] });

    const res = await request(app)
      .post('/api/bug-reports')
      .set('Authorization', 'Bearer t')
      .send({
        action:      'Tap send',
        description: 'App crashed',
        device_info: 'iPhone 15',
        os_info:     'iOS 18',
        // app_version omitted on purpose → must be inserted as NULL
        // user_id in body must be ignored (we use req.user.id).
        user_id: '00000000-0000-0000-0000-000000000000',
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('bug-id');
    expect(res.body.created_at).toBe('2026-04-29T12:00:00Z');

    const insertParams = pool.query.mock.calls[1][1];
    expect(insertParams).toEqual([
      USER_ID,
      'Tap send',
      'App crashed',
      'iPhone 15',
      'iOS 18',
      null, // app_version not provided → NULL coalesced server-side
    ]);
  });
});
