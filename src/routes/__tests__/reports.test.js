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

const REPORTER_ID = '550e8400-e29b-41d4-a716-446655440000';
const REPORTED_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const ACTIVE_USER = {
  id:           REPORTER_ID,
  firebase_uid: 'fbuid-reporter',
  email:        'reporter@example.com',
  name:         'Reporter',
  is_active:    true,
};

function mockAuthOk() {
  mockVerifyIdToken.mockResolvedValueOnce({ uid: ACTIVE_USER.firebase_uid });
  pool.query.mockResolvedValueOnce({ rows: [ACTIVE_USER] });
}

describe('POST /api/reports', () => {
  beforeEach(() => jest.resetAllMocks());

  test('Missing Authorization → 401', async () => {
    const res = await request(app).post('/api/reports').send({ reported_id: REPORTED_ID, reason: 'spam' });
    expect(res.status).toBe(401);
  });

  test('reported_id not a UUID → 422', async () => {
    mockAuthOk();
    const res = await request(app)
      .post('/api/reports')
      .set('Authorization', 'Bearer t')
      .send({ reported_id: 'nope', reason: 'spam' });

    expect(res.status).toBe(422);
  });

  test('reason not in allowed enum → 422', async () => {
    mockAuthOk();
    const res = await request(app)
      .post('/api/reports')
      .set('Authorization', 'Bearer t')
      .send({ reported_id: REPORTED_ID, reason: 'totally_made_up' });

    expect(res.status).toBe(422);
  });

  test('Self-report → 400', async () => {
    mockAuthOk();
    const res = await request(app)
      .post('/api/reports')
      .set('Authorization', 'Bearer t')
      .send({ reported_id: REPORTER_ID, reason: 'spam' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/yourself/i);
  });

  test('Nominal → 201 + INSERT with reporter_id from auth (anti-tampering)', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'report-id' }] });

    const res = await request(app)
      .post('/api/reports')
      .set('Authorization', 'Bearer t')
      .send({
        reported_id: REPORTED_ID,
        reason:      'harassment',
        details:     'Sent threatening DMs',
        // Even if a malicious client tries to pass reporter_id in body,
        // the route ignores it and always uses req.user.id.
        reporter_id: '00000000-0000-0000-0000-000000000000',
      });

    expect(res.status).toBe(201);
    expect(res.body.report_id).toBe('report-id');

    const insertParams = pool.query.mock.calls[1][1];
    expect(insertParams).toEqual([REPORTER_ID, REPORTED_ID, 'harassment', 'Sent threatening DMs']);
  });
});
