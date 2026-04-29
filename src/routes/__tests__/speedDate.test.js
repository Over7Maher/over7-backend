const mockVerifyIdToken     = jest.fn();
const mockTodayBrussels     = jest.fn();
const mockBrusselsHour      = jest.fn();
const mockGetCurrentSlot    = jest.fn();
const mockGetLiveSlotsToday = jest.fn();

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

// Time-dependent helpers — mocked for determinism. addDays stays as a real
// pure-string implementation so the route's 7-day window math still works.
jest.mock('../../utils/slots', () => ({
  todayBrussels:     () => mockTodayBrussels(),
  brusselsHour:      () => mockBrusselsHour(),
  getCurrentSlot:    () => mockGetCurrentSlot(),
  getLiveSlotsToday: () => mockGetLiveSlotsToday(),
  addDays: (date, n) => {
    const d = new Date(date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  },
}));

const request = require('supertest');
const app  = require('../../app');
const pool = require('../../db/pool');

const USER_ID = '550e8400-e29b-41d4-a716-446655440000';

const POOL_USER = {
  id:           USER_ID,
  firebase_uid: 'fbuid-speed',
  email:        'me@example.com',
  name:         'Me',
  is_active:    true,
  is_in_pool:   true,
  latitude:     48.85,
  longitude:    2.30,
  gender:       'male',
  seeking:      'female',
  speed_date_distance_max: 20,
};

function mockAuthOk(overrides = {}) {
  mockVerifyIdToken.mockResolvedValueOnce({ uid: POOL_USER.firebase_uid });
  pool.query.mockResolvedValueOnce({ rows: [{ ...POOL_USER, ...overrides }] });
}

describe('POST /api/speed-date/register', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockTodayBrussels.mockReturnValue('2026-04-29');
    mockBrusselsHour.mockReturnValue(14);
  });

  test('Missing Authorization → 401', async () => {
    const res = await request(app).post('/api/speed-date/register').send({ slot_type: 'afternoon' });
    expect(res.status).toBe(401);
  });

  test('Invalid slot_type → 422', async () => {
    mockAuthOk();
    const res = await request(app)
      .post('/api/speed-date/register')
      .set('Authorization', 'Bearer t')
      .send({ slot_type: 'morning' });

    expect(res.status).toBe(422);
  });

  test('User not in pool → 403', async () => {
    mockAuthOk({ is_in_pool: false });
    const res = await request(app)
      .post('/api/speed-date/register')
      .set('Authorization', 'Bearer t')
      .send({ slot_type: 'afternoon' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/pool access/i);
  });

  test('slot_date outside the 7-day window → 400', async () => {
    mockAuthOk();
    const res = await request(app)
      .post('/api/speed-date/register')
      .set('Authorization', 'Bearer t')
      .send({ slot_type: 'afternoon', slot_date: '2026-06-01' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/slot_date must be between/i);
  });

  test('Nominal default-today → 201 + INSERT (auth user id, today, slot_type)', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 'reg-id', slot_date: '2026-04-29', slot_type: 'afternoon', created_at: '2026-04-29T13:00:00Z' }],
    });

    const res = await request(app)
      .post('/api/speed-date/register')
      .set('Authorization', 'Bearer t')
      .send({ slot_type: 'afternoon' });

    expect(res.status).toBe(201);
    expect(res.body.slot_type).toBe('afternoon');
    expect(pool.query.mock.calls[1][1]).toEqual([USER_ID, '2026-04-29', 'afternoon']);
  });

  test('Nominal with explicit slot_date in window → 201', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 'reg-id', slot_date: '2026-05-02', slot_type: 'evening', created_at: '2026-04-29T13:00:00Z' }],
    });

    const res = await request(app)
      .post('/api/speed-date/register')
      .set('Authorization', 'Bearer t')
      .send({ slot_type: 'evening', slot_date: '2026-05-02' });

    expect(res.status).toBe(201);
    expect(pool.query.mock.calls[1][1]).toEqual([USER_ID, '2026-05-02', 'evening']);
  });
});

describe('DELETE /api/speed-date/register', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockTodayBrussels.mockReturnValue('2026-04-29');
  });

  test('Cancel today (no slot_type) → 200 with cancelled count', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: 'r1', slot_type: 'afternoon', slot_date: '2026-04-29' },
        { id: 'r2', slot_type: 'evening',   slot_date: '2026-04-29' },
      ],
    });

    const res = await request(app)
      .delete('/api/speed-date/register')
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body.cancelled).toBe(2);
    expect(res.body.registrations).toHaveLength(2);
    // SQL must NOT include the slot_type filter when not provided.
    expect(pool.query.mock.calls[1][0]).not.toMatch(/AND slot_type =/);
  });

  test('Cancel specific slot_type → SQL includes slot_type filter', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'r1', slot_type: 'evening', slot_date: '2026-04-29' }] });

    await request(app)
      .delete('/api/speed-date/register?slot_type=evening')
      .set('Authorization', 'Bearer t');

    expect(pool.query.mock.calls[1][0]).toMatch(/AND slot_type = \$3/);
    expect(pool.query.mock.calls[1][1]).toEqual([USER_ID, '2026-04-29', 'evening']);
  });
});

describe('GET /api/speed-date/my-slots', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockTodayBrussels.mockReturnValue('2026-04-29');
    mockGetCurrentSlot.mockReturnValue({ slot_type: 'afternoon', slot_date: '2026-04-29' });
  });

  test('Auth OK → 200 with registrations + is_registered_now=true when in current slot', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 'r1', slot_type: 'afternoon', slot_date: '2026-04-29', created_at: 't' }],
    });

    const res = await request(app)
      .get('/api/speed-date/my-slots')
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body.is_registered_now).toBe(true);
    expect(res.body.current_slot.slot_type).toBe('afternoon');
    expect(res.body.speed_date_distance_max).toBe(20);
  });
});

describe('GET /api/speed-date/slots-grid', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockTodayBrussels.mockReturnValue('2026-04-29');
  });

  test('Auth OK → 200 with 7-day grid + per-slot booleans', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({
      rows: [
        { slot_date: '2026-04-29', slot_type: 'afternoon' },
        { slot_date: '2026-05-01', slot_type: 'evening' },
      ],
    });

    const res = await request(app)
      .get('/api/speed-date/slots-grid')
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body.today).toBe('2026-04-29');
    expect(res.body.grid).toHaveLength(7);
    expect(res.body.grid[0]).toEqual({ slot_date: '2026-04-29', afternoon: true,  evening: false });
    expect(res.body.grid[2]).toEqual({ slot_date: '2026-05-01', afternoon: false, evening: true  });
    expect(res.body.grid[6].slot_date).toBe('2026-05-05');
  });
});

describe('GET /api/speed-date/profiles', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockTodayBrussels.mockReturnValue('2026-04-29');
    mockGetCurrentSlot.mockReturnValue({ slot_type: 'afternoon', slot_date: '2026-04-29' });
    mockGetLiveSlotsToday.mockReturnValue(['afternoon', 'evening']);
  });

  test('User not in pool → 403', async () => {
    mockAuthOk({ is_in_pool: false });
    const res = await request(app)
      .get('/api/speed-date/profiles')
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(403);
  });

  test('Missing latitude/longitude → 400', async () => {
    mockAuthOk({ latitude: null, longitude: null });
    const res = await request(app)
      .get('/api/speed-date/profiles')
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(400);
  });

  test('All today\'s slots expired (no live slots) → 403', async () => {
    mockAuthOk();
    mockGetLiveSlotsToday.mockReturnValue([]);

    const res = await request(app)
      .get('/api/speed-date/profiles')
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/expired|come back/i);
    expect(res.body.live_slots).toEqual([]);
  });

  test('User not registered to any live slot → 403', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rows: [] }); // mySlots query returns empty

    const res = await request(app)
      .get('/api/speed-date/profiles')
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/register/i);
  });

  test('Nominal → 200 with candidates + meta', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rows: [{ slot_type: 'afternoon' }] });          // mySlots
    pool.query.mockResolvedValueOnce({                                                  // candidates
      rows: [
        { id: 'c1', name: 'A', slot_types: ['afternoon'], in_current_slot: true,  dist_km: 3 },
        { id: 'c2', name: 'B', slot_types: ['evening'],   in_current_slot: false, dist_km: 8 },
      ],
    });

    const res = await request(app)
      .get('/api/speed-date/profiles')
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(200);
    expect(res.body.profiles).toHaveLength(2);
    expect(res.body.my_slots).toEqual(['afternoon']);
    expect(res.body.live_slots).toEqual(['afternoon', 'evening']);
    expect(res.body.speed_date_distance_max).toBe(20);
    expect(res.body.no_more_profiles).toBe(true); // 2 < default limit 20
  });
});

describe('PATCH /api/speed-date/distance', () => {
  beforeEach(() => jest.resetAllMocks());

  test('distance_max out of [5,50] → 422', async () => {
    mockAuthOk();
    const res = await request(app)
      .patch('/api/speed-date/distance')
      .set('Authorization', 'Bearer t')
      .send({ distance_max: 100 });

    expect(res.status).toBe(422);
  });

  test('Nominal update → 200 + UPDATE scoped to auth user', async () => {
    mockAuthOk();
    pool.query.mockResolvedValueOnce({ rows: [{ speed_date_distance_max: 30 }] });

    const res = await request(app)
      .patch('/api/speed-date/distance')
      .set('Authorization', 'Bearer t')
      .send({ distance_max: 30 });

    expect(res.status).toBe(200);
    expect(res.body.speed_date_distance_max).toBe(30);
    expect(pool.query.mock.calls[1][1]).toEqual([30, USER_ID]);
  });
});
