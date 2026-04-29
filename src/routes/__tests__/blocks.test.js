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

const BLOCKER_ID = '550e8400-e29b-41d4-a716-446655440000';
const BLOCKED_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const ACTIVE_USER = {
  id:           BLOCKER_ID,
  firebase_uid: 'fbuid-blocker',
  email:        'blocker@example.com',
  name:         'Blocker',
  is_active:    true,
};

function mockAuthOk() {
  mockVerifyIdToken.mockResolvedValueOnce({ uid: ACTIVE_USER.firebase_uid });
  pool.query.mockResolvedValueOnce({ rows: [ACTIVE_USER] });
}

function mockClient() {
  const client = { query: jest.fn(), release: jest.fn() };
  pool.connect.mockResolvedValueOnce(client);
  return client;
}

describe('POST /api/blocks', () => {
  beforeEach(() => jest.resetAllMocks());

  test('Missing Authorization → 401', async () => {
    const res = await request(app).post('/api/blocks').send({ blocked_id: BLOCKED_ID });
    expect(res.status).toBe(401);
  });

  test('blocked_id not a UUID → 422', async () => {
    mockAuthOk();
    const res = await request(app)
      .post('/api/blocks')
      .set('Authorization', 'Bearer t')
      .send({ blocked_id: 'nope' });

    expect(res.status).toBe(422);
  });

  test('Self-block → 400', async () => {
    mockAuthOk();
    const res = await request(app)
      .post('/api/blocks')
      .set('Authorization', 'Bearer t')
      .send({ blocked_id: BLOCKER_ID });

    expect(res.status).toBe(400);
  });

  test('Block without existing match → 204, no socket emit, transaction commits', async () => {
    mockAuthOk();
    const client = mockClient();
    client.query
      .mockResolvedValueOnce({})                                       // BEGIN
      .mockResolvedValueOnce({})                                       // INSERT block
      .mockResolvedValueOnce({ rows: [] })                             // UPDATE matches → no rows
      .mockResolvedValueOnce({});                                      // COMMIT

    const res = await request(app)
      .post('/api/blocks')
      .set('Authorization', 'Bearer t')
      .send({ blocked_id: BLOCKED_ID });

    expect(res.status).toBe(204);
    expect(client.query.mock.calls[0][0]).toBe('BEGIN');
    expect(client.query.mock.calls[3][0]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(mockEmitToRoom).not.toHaveBeenCalled();
  });

  test('Block WITH existing match → 204 + match deactivated + 2 socket emits', async () => {
    mockAuthOk();
    const client = mockClient();
    client.query
      .mockResolvedValueOnce({})                                       // BEGIN
      .mockResolvedValueOnce({})                                       // INSERT block
      .mockResolvedValueOnce({ rows: [{ id: 'match-id' }] })           // UPDATE matches RETURNING
      .mockResolvedValueOnce({});                                      // COMMIT

    const res = await request(app)
      .post('/api/blocks')
      .set('Authorization', 'Bearer t')
      .send({ blocked_id: BLOCKED_ID });

    expect(res.status).toBe(204);
    // Both sides receive match_cancelled.
    expect(mockEmitToRoom).toHaveBeenCalledTimes(2);
    expect(mockEmitToRoom).toHaveBeenCalledWith(`user:${BLOCKER_ID}`, 'match_cancelled', { match_id: 'match-id' });
    expect(mockEmitToRoom).toHaveBeenCalledWith(`user:${BLOCKED_ID}`, 'match_cancelled', { match_id: 'match-id' });

    // Anti-tampering: blocker_id passed to INSERT is the auth user id.
    const insertCall = client.query.mock.calls[1];
    expect(insertCall[0]).toMatch(/INSERT INTO blocks/);
    expect(insertCall[1]).toEqual([BLOCKER_ID, BLOCKED_ID]);
  });

  test('Transaction error → ROLLBACK + release', async () => {
    mockAuthOk();
    const client = mockClient();
    client.query
      .mockResolvedValueOnce({})                                       // BEGIN
      .mockRejectedValueOnce(new Error('connection lost'))             // INSERT block throws
      .mockResolvedValueOnce({});                                      // ROLLBACK

    const res = await request(app)
      .post('/api/blocks')
      .set('Authorization', 'Bearer t')
      .send({ blocked_id: BLOCKED_ID });

    expect(res.status).toBe(500);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe('DELETE /api/blocks/:blockedId', () => {
  beforeEach(() => jest.resetAllMocks());

  test('blockedId not a UUID → 422', async () => {
    mockAuthOk();
    const res = await request(app)
      .delete('/api/blocks/nope')
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(422);
  });

  test('Nominal unblock → 204 + DELETE scoped to (auth user, blocked id)', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(app)
      .delete(`/api/blocks/${BLOCKED_ID}`)
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(204);
    const deleteCall = pool.query.mock.calls[1];
    expect(deleteCall[0]).toMatch(/DELETE FROM blocks/);
    expect(deleteCall[1]).toEqual([BLOCKER_ID, BLOCKED_ID]);
  });
});
