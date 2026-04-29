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
jest.mock('../../services/poolTransition', () => ({ handlePoolTransition: jest.fn() }));

const request = require('supertest');
const app  = require('../../app');
const pool = require('../../db/pool');
const { handlePoolTransition } = require('../../services/poolTransition');

const USER_ID   = '550e8400-e29b-41d4-a716-446655440000';
const PROMPT1_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const PROMPT2_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

const ACTIVE_USER = {
  id:           USER_ID,
  firebase_uid: 'fbuid-prompt',
  email:        'me@example.com',
  name:         'Me',
  is_active:    true,
  is_in_pool:   false,
  completude_pct: 50,
  birth_date:   '1995-01-01',
  age_min:      25,
  age_max:      35,
  distance_max: 50,
  latitude:     48.85,
  longitude:    2.30,
  gender:       'male',
  seeking:      'female',
};

function mockAuthOk(overrides = {}) {
  mockVerifyIdToken.mockResolvedValueOnce({ uid: ACTIVE_USER.firebase_uid });
  pool.query.mockResolvedValueOnce({ rows: [{ ...ACTIVE_USER, ...overrides }] });
}

function mockClient() {
  const client = { query: jest.fn(), release: jest.fn() };
  pool.connect.mockResolvedValueOnce(client);
  return client;
}

describe('GET /api/prompts/catalog', () => {
  beforeEach(() => jest.resetAllMocks());

  test('Missing Authorization → 401', async () => {
    const res = await request(app).get('/api/prompts/catalog');
    expect(res.status).toBe(401);
  });

  test('Auth OK → 200 with catalog rows', async () => {
    mockAuthOk();
    const catalog = [
      { id: PROMPT1_ID, question: 'Favorite song?',  category: 'lifestyle', position: 1 },
      { id: PROMPT2_ID, question: 'Dream vacation?', category: 'travel',    position: 2 },
    ];
    pool.query.mockResolvedValueOnce({ rows: catalog });

    const res = await request(app)
      .get('/api/prompts/catalog')
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body.prompts).toEqual(catalog);
  });
});

describe('GET /api/prompts/mine', () => {
  beforeEach(() => jest.resetAllMocks());

  test('Auth OK → 200 with user prompts', async () => {
    mockAuthOk();
    const myPrompts = [
      { id: 'up1', prompt_id: PROMPT1_ID, answer: 'Bohemian Rhapsody', position: 0, question: 'Favorite song?', category: 'lifestyle' },
    ];
    pool.query.mockResolvedValueOnce({ rows: myPrompts });

    const res = await request(app)
      .get('/api/prompts/mine')
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body.prompts).toEqual(myPrompts);
    // SQL filtered on the auth user id (anti-leak guarantee).
    expect(pool.query.mock.calls[1][1]).toEqual([USER_ID]);
  });
});

describe('PUT /api/prompts/mine', () => {
  beforeEach(() => jest.resetAllMocks());

  test('Missing Authorization → 401', async () => {
    const res = await request(app).put('/api/prompts/mine').send({ prompts: [] });
    expect(res.status).toBe(401);
  });

  test('prompts not an array → 422', async () => {
    mockAuthOk();
    const res = await request(app)
      .put('/api/prompts/mine')
      .set('Authorization', 'Bearer t')
      .send({ prompts: 'not-an-array' });

    expect(res.status).toBe(422);
  });

  test('More than 5 prompts → 422', async () => {
    mockAuthOk();
    const tooMany = Array.from({ length: 6 }, () => ({ prompt_id: PROMPT1_ID, answer: 'x' }));
    const res = await request(app)
      .put('/api/prompts/mine')
      .set('Authorization', 'Bearer t')
      .send({ prompts: tooMany });

    expect(res.status).toBe(422);
  });

  test('Entry missing prompt_id → 400', async () => {
    mockAuthOk();
    const res = await request(app)
      .put('/api/prompts/mine')
      .set('Authorization', 'Bearer t')
      .send({ prompts: [{ answer: 'forgot prompt_id' }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/prompt_id/i);
  });

  test('Entry missing answer → 400', async () => {
    mockAuthOk();
    const res = await request(app)
      .put('/api/prompts/mine')
      .set('Authorization', 'Bearer t')
      .send({ prompts: [{ prompt_id: PROMPT1_ID }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/answer/i);
  });

  test('Answer empty/whitespace-only → 400', async () => {
    mockAuthOk();
    const res = await request(app)
      .put('/api/prompts/mine')
      .set('Authorization', 'Bearer t')
      .send({ prompts: [{ prompt_id: PROMPT1_ID, answer: '   ' }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/1-150/i);
  });

  test('Answer > 150 chars → 400', async () => {
    mockAuthOk();
    const res = await request(app)
      .put('/api/prompts/mine')
      .set('Authorization', 'Bearer t')
      .send({ prompts: [{ prompt_id: PROMPT1_ID, answer: 'a'.repeat(151) }] });

    expect(res.status).toBe(400);
  });

  test('Nominal replace → 200, transaction commits, pool transition fired', async () => {
    mockAuthOk();
    const client = mockClient();
    client.query
      .mockResolvedValueOnce({})                                     // BEGIN
      .mockResolvedValueOnce({})                                     // DELETE existing
      .mockResolvedValueOnce({})                                     // INSERT prompt 1
      .mockResolvedValueOnce({})                                     // INSERT prompt 2
      .mockResolvedValueOnce({                                        // UPDATE users RETURNING *
        rows: [{ ...ACTIVE_USER, completude_pct: 70, is_in_pool: true }],
      })
      .mockResolvedValueOnce({});                                    // COMMIT

    const res = await request(app)
      .put('/api/prompts/mine')
      .set('Authorization', 'Bearer t')
      .send({
        prompts: [
          { prompt_id: PROMPT1_ID, answer: 'Bohemian Rhapsody' },
          { prompt_id: PROMPT2_ID, answer: 'Iceland' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.completude_pct).toBe(70);
    expect(res.body.id).toBe(USER_ID);
    expect(res.body).not.toHaveProperty('firebase_uid'); // formatUser whitelists

    // Transaction control flow
    expect(client.query.mock.calls[0][0]).toBe('BEGIN');
    expect(client.query.mock.calls[1][0]).toMatch(/DELETE FROM user_prompts/);
    expect(client.query.mock.calls[1][1]).toEqual([USER_ID]); // anti-leak: scoped to auth user
    expect(client.query.mock.calls[2][0]).toMatch(/INSERT INTO user_prompts/);
    expect(client.query.mock.calls[2][1]).toEqual([USER_ID, PROMPT1_ID, 'Bohemian Rhapsody', 0]);
    expect(client.query.mock.calls[3][1]).toEqual([USER_ID, PROMPT2_ID, 'Iceland', 1]);
    expect(client.query.mock.calls[5][0]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);

    // Pool transition fired. We don't assert the new isInPool because
    // shouldBeInPool runs for real here (not mocked) and depends on many
    // user fields beyond completude — keep the assertion to the invariants
    // that matter: it was called once, scoped to the auth user, with the
    // pre-state taken from req.user.is_in_pool.
    expect(handlePoolTransition).toHaveBeenCalledTimes(1);
    expect(handlePoolTransition).toHaveBeenCalledWith(expect.objectContaining({
      userId:    USER_ID,
      wasInPool: false,
      isInPool:  expect.any(Boolean),
    }));
  });

  test('Empty array → 200, transaction wipes prompts (no INSERT loop)', async () => {
    mockAuthOk();
    const client = mockClient();
    client.query
      .mockResolvedValueOnce({})                                     // BEGIN
      .mockResolvedValueOnce({})                                     // DELETE existing
      .mockResolvedValueOnce({ rows: [{ ...ACTIVE_USER, completude_pct: 30 }] })  // UPDATE users
      .mockResolvedValueOnce({});                                    // COMMIT

    const res = await request(app)
      .put('/api/prompts/mine')
      .set('Authorization', 'Bearer t')
      .send({ prompts: [] });

    expect(res.status).toBe(200);
    // Only 4 client.query calls (BEGIN, DELETE, UPDATE, COMMIT) — no INSERT loop.
    expect(client.query).toHaveBeenCalledTimes(4);
  });
});
