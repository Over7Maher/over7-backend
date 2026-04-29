const mockVerifyIdToken  = jest.fn();
const mockEmitToRoom     = jest.fn();
const mockSendPushToUser = jest.fn();

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
};

function mockAuthOk(overrides = {}) {
  mockVerifyIdToken.mockResolvedValueOnce({ uid: ACTIVE_USER.firebase_uid });
  pool.query.mockResolvedValueOnce({ rows: [{ ...ACTIVE_USER, ...overrides }] });
}

// getMembership() helper in messages.js does pool.query first → mock returns a row when
// the caller IS a member, or empty rows when the membership check fails.
function mockMembership(isMember) {
  if (isMember) {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: MATCH_ID, user1_id: ME_ID, user2_id: OTHER_ID }],
    });
  } else {
    pool.query.mockResolvedValueOnce({ rows: [] });
  }
}

function mockClient() {
  const client = { query: jest.fn(), release: jest.fn() };
  pool.connect.mockResolvedValueOnce(client);
  return client;
}

describe('GET /api/messages/:matchId', () => {
  beforeEach(() => jest.resetAllMocks());

  test('Missing Authorization → 401', async () => {
    const res = await request(app).get(`/api/messages/${MATCH_ID}`);
    expect(res.status).toBe(401);
  });

  test('matchId not a UUID → 422', async () => {
    mockAuthOk();
    const res = await request(app)
      .get('/api/messages/not-a-uuid')
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(422);
  });

  test('User not a member of match → 404 (anti-leak)', async () => {
    mockAuthOk();
    mockMembership(false);

    const res = await request(app)
      .get(`/api/messages/${MATCH_ID}`)
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(404);
    // Transaction must NOT have started since membership failed.
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('Member access → 200 + transaction marks read + returns oldest-first', async () => {
    mockAuthOk();
    mockMembership(true);
    const client = mockClient();

    // Sequence: BEGIN → UPDATE read_at → SELECT messages → COMMIT
    client.query
      .mockResolvedValueOnce({})                                       // BEGIN
      .mockResolvedValueOnce({ rowCount: 2 })                          // UPDATE read_at
      .mockResolvedValueOnce({                                         // SELECT messages (DESC)
        rows: [
          { id: 'm3', sender_id: OTHER_ID, content: 'newest',  created_at: '2026-04-29T12:00:00Z' },
          { id: 'm2', sender_id: ME_ID,    content: 'middle',  created_at: '2026-04-29T11:00:00Z' },
          { id: 'm1', sender_id: OTHER_ID, content: 'oldest',  created_at: '2026-04-29T10:00:00Z' },
        ],
      })
      .mockResolvedValueOnce({});                                      // COMMIT

    const res = await request(app)
      .get(`/api/messages/${MATCH_ID}`)
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    // Route reverses the rows so oldest is first (chat UI convention).
    expect(res.body.map(m => m.id)).toEqual(['m1', 'm2', 'm3']);

    expect(client.query.mock.calls[0][0]).toBe('BEGIN');
    expect(client.query.mock.calls[1][0]).toMatch(/SET\s+read_at\s*=\s*NOW\(\)/);
    expect(client.query.mock.calls[1][0]).toMatch(/AND\s+sender_id\s*!=\s*\$2/); // only OTHER's messages
    expect(client.query.mock.calls[3][0]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('Member access + no messages yet → 200 with empty array', async () => {
    mockAuthOk();
    mockMembership(true);
    const client = mockClient();
    client.query
      .mockResolvedValueOnce({})              // BEGIN
      .mockResolvedValueOnce({ rowCount: 0 })  // UPDATE no rows
      .mockResolvedValueOnce({ rows: [] })    // SELECT empty
      .mockResolvedValueOnce({});              // COMMIT

    const res = await request(app)
      .get(`/api/messages/${MATCH_ID}`)
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('POST /api/messages/:matchId', () => {
  beforeEach(() => jest.resetAllMocks());

  test('Missing Authorization → 401', async () => {
    const res = await request(app)
      .post(`/api/messages/${MATCH_ID}`)
      .send({ content: 'hi' });
    expect(res.status).toBe(401);
  });

  test('Empty content → 422', async () => {
    mockAuthOk();
    const res = await request(app)
      .post(`/api/messages/${MATCH_ID}`)
      .set('Authorization', 'Bearer t')
      .send({ content: '   ' });

    expect(res.status).toBe(422);
  });

  test('content > 1000 chars → 422', async () => {
    mockAuthOk();
    const res = await request(app)
      .post(`/api/messages/${MATCH_ID}`)
      .set('Authorization', 'Bearer t')
      .send({ content: 'a'.repeat(1001) });

    expect(res.status).toBe(422);
  });

  test('User not a member of match → 404 (anti-leak)', async () => {
    mockAuthOk();
    mockMembership(false);

    const res = await request(app)
      .post(`/api/messages/${MATCH_ID}`)
      .set('Authorization', 'Bearer t')
      .send({ content: 'hello' });

    expect(res.status).toBe(404);
    // No INSERT, no socket emit, no push.
    expect(pool.query).toHaveBeenCalledTimes(2); // auth + membership only
    expect(mockEmitToRoom).not.toHaveBeenCalled();
    expect(mockSendPushToUser).not.toHaveBeenCalled();
  });

  test('Nominal send → 201 + INSERT + socket broadcast + push to other user', async () => {
    mockAuthOk();
    mockMembership(true);
    pool.query.mockResolvedValueOnce({                                  // INSERT RETURNING
      rows: [{
        id:         'msg-uuid',
        match_id:   MATCH_ID,
        sender_id:  ME_ID,
        content:    'hello!',
        read_at:    null,
        created_at: '2026-04-29T12:00:00Z',
      }],
    });

    const res = await request(app)
      .post(`/api/messages/${MATCH_ID}`)
      .set('Authorization', 'Bearer t')
      .send({ content: 'hello!' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id:          'msg-uuid',
      match_id:    MATCH_ID,
      sender_id:   ME_ID,
      content:     'hello!',
      sender_name: ACTIVE_USER.name,
    });

    // Anti-tampering: sender_id passed to INSERT MUST be ME_ID (req.user.id),
    // never trusted from request body. INSERT params: [uuidv4(), matchId, userId, content].
    const insertCall = pool.query.mock.calls[2];
    expect(insertCall[0]).toMatch(/INSERT INTO messages/);
    const [generatedId, sqlMatchId, sqlSenderId, sqlContent] = insertCall[1];
    expect(typeof generatedId).toBe('string'); // uuidv4 produced
    expect(sqlMatchId).toBe(MATCH_ID);
    expect(sqlSenderId).toBe(ME_ID); // ← anti-tampering guarantee
    expect(sqlContent).toBe('hello!');

    // Socket: broadcast to match room + notify other's personal room.
    expect(mockEmitToRoom).toHaveBeenCalledWith(`match:${MATCH_ID}`,  'new_message',  expect.objectContaining({ id: 'msg-uuid', sender_id: ME_ID }));
    expect(mockEmitToRoom).toHaveBeenCalledWith(`user:${OTHER_ID}`,  'notification', { type: 'new_message', match_id: MATCH_ID });

    // Push: only to the recipient (not to self), category='message'.
    expect(mockSendPushToUser).toHaveBeenCalledTimes(1);
    expect(mockSendPushToUser).toHaveBeenCalledWith(OTHER_ID, ACTIVE_USER.name, 'Nouveau message reçu', { match_id: MATCH_ID, type: 'new_message' }, 'message');
  });

  test('Anti-tampering: body-supplied sender_id is ignored', async () => {
    mockAuthOk();
    mockMembership(true);
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 'msg-uuid', match_id: MATCH_ID, sender_id: ME_ID, content: 'hi', read_at: null, created_at: 't' }],
    });

    await request(app)
      .post(`/api/messages/${MATCH_ID}`)
      .set('Authorization', 'Bearer t')
      .send({ content: 'hi', sender_id: OTHER_ID }); // attacker tries to spoof

    // INSERT params position 3 (sender_id) must still be ME_ID.
    const insertParams = pool.query.mock.calls[2][1];
    expect(insertParams[2]).toBe(ME_ID);
    expect(insertParams[2]).not.toBe(OTHER_ID);
  });

  test('Reverse-side caller (user2) → push goes to user1', async () => {
    mockAuthOk();
    // Membership returns user2_id = ME_ID, so the "other" should be user1_id.
    pool.query.mockResolvedValueOnce({
      rows: [{ id: MATCH_ID, user1_id: OTHER_ID, user2_id: ME_ID }],
    });
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 'msg-uuid', match_id: MATCH_ID, sender_id: ME_ID, content: 'hi', read_at: null, created_at: 't' }],
    });

    await request(app)
      .post(`/api/messages/${MATCH_ID}`)
      .set('Authorization', 'Bearer t')
      .send({ content: 'hi' });

    expect(mockSendPushToUser).toHaveBeenCalledWith(OTHER_ID, expect.any(String), expect.any(String), expect.any(Object), 'message');
    expect(mockEmitToRoom).toHaveBeenCalledWith(`user:${OTHER_ID}`, 'notification', expect.any(Object));
  });
});
