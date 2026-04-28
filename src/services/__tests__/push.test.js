jest.mock('../../db/pool', () => ({
  query: jest.fn(),
}));

const pool = require('../../db/pool');
const { sendPush, sendPushToUser } = require('../push');

function mockExpoTicket(ticket) {
  global.fetch = jest.fn().mockResolvedValue({
    json: () => Promise.resolve({ data: ticket }),
  });
}

function mockExpoTickets(...tickets) {
  global.fetch = jest.fn();
  for (const ticket of tickets) {
    global.fetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ data: ticket }),
    });
  }
}

describe('sendPush — Expo response parsing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('Success ticket (single object) → { ok: true, ticketId }', async () => {
    mockExpoTicket({ status: 'ok', id: 'ticket-abc-123' });

    const result = await sendPush('ExponentPushToken[XXX]', 'Test', 'Body');

    expect(result).toEqual({ ok: true, ticketId: 'ticket-abc-123' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('Bulk array response → first ticket extracted', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: () => Promise.resolve({ data: [{ status: 'ok', id: 'ticket-1' }] }),
    });

    const result = await sendPush('ExponentPushToken[XXX]', 'Test', 'Body');

    expect(result.ok).toBe(true);
    expect(result.ticketId).toBe('ticket-1');
  });

  test('Error DeviceNotRegistered → { ok: false, code }', async () => {
    mockExpoTicket({
      status: 'error',
      message: 'Device not registered',
      details: { error: 'DeviceNotRegistered' },
    });

    const result = await sendPush('ExponentPushToken[STALE]', 'Test', 'Body');

    expect(result.ok).toBe(false);
    expect(result.code).toBe('DeviceNotRegistered');
    expect(result.message).toBe('Device not registered');
  });

  test('Error MessageTooBig → propagated code', async () => {
    mockExpoTicket({
      status: 'error',
      message: 'Payload too large',
      details: { error: 'MessageTooBig' },
    });

    const result = await sendPush('ExponentPushToken[XXX]', 'Test', 'Body');

    expect(result.code).toBe('MessageTooBig');
  });

  test('Empty/null response → { ok: false, code: unexpected_response }', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: () => Promise.resolve(null),
    });

    const result = await sendPush('ExponentPushToken[XXX]', 'Test', 'Body');

    expect(result.ok).toBe(false);
    expect(result.code).toBe('unexpected_response');
  });

  test('Network error (fetch throws) → { ok: false, code: network_error }', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await sendPush('ExponentPushToken[XXX]', 'Test', 'Body');

    expect(result.ok).toBe(false);
    expect(result.code).toBe('network_error');
    expect(result.message).toBe('ECONNREFUSED');
  });

  test('Unknown error code (no details.error) → fallback unknown_error', async () => {
    mockExpoTicket({
      status: 'error',
      message: 'Mystery',
      details: {},
    });

    const result = await sendPush('ExponentPushToken[XXX]', 'Test', 'Body');

    expect(result.code).toBe('unknown_error');
  });
});

describe('sendPush — MessageRateExceeded retry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('Rate-exceeded then ok → retries and returns ok=true', async () => {
    mockExpoTickets(
      { status: 'error', message: 'Rate', details: { error: 'MessageRateExceeded' } },
      { status: 'ok', id: 'after-retry' },
    );

    const promise = sendPush('ExponentPushToken[XXX]', 'Test', 'Body');
    await jest.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result.ok).toBe(true);
    expect(result.ticketId).toBe('after-retry');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('Rate-exceeded x3 → gives up after 3 attempts, returns code', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: () => Promise.resolve({
        data: { status: 'error', message: 'Rate', details: { error: 'MessageRateExceeded' } },
      }),
    });

    const promise = sendPush('ExponentPushToken[XXX]', 'Test', 'Body');
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(result.code).toBe('MessageRateExceeded');
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  test('DeviceNotRegistered does NOT trigger retry', async () => {
    mockExpoTicket({
      status: 'error',
      message: 'Stale',
      details: { error: 'DeviceNotRegistered' },
    });

    const result = await sendPush('ExponentPushToken[XXX]', 'Test', 'Body');

    expect(result.code).toBe('DeviceNotRegistered');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('Rate-exceeded then DeviceNotRegistered (mid-retry) → no further retry', async () => {
    mockExpoTickets(
      { status: 'error', message: 'Rate',  details: { error: 'MessageRateExceeded' } },
      { status: 'error', message: 'Stale', details: { error: 'DeviceNotRegistered' } },
    );

    const promise = sendPush('ExponentPushToken[XXX]', 'Test', 'Body');
    await jest.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result.code).toBe('DeviceNotRegistered');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('sendPushToUser — DB lookup, opt-out, stale token cleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  test('No push_token in DB → silent skip (no fetch)', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ push_token: null, notification_preferences: {} }],
    });

    await sendPushToUser('user-1', 'Test', 'Body');

    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('User row missing → silent skip (no fetch)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await sendPushToUser('ghost-user', 'Test', 'Body');

    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('Category opt-out (notification_preferences[category] = false) → silent skip', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        push_token: 'ExponentPushToken[OK]',
        notification_preferences: { match: false },
      }],
    });

    await sendPushToUser('user-1', 'Test', 'Body', {}, 'match');

    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('Category opt-in (preference true) → fetch called', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        push_token: 'ExponentPushToken[OK]',
        notification_preferences: { match: true },
      }],
    });
    global.fetch = jest.fn().mockResolvedValue({
      json: () => Promise.resolve({ data: { status: 'ok', id: 't1' } }),
    });

    await sendPushToUser('user-1', 'Test', 'Body', {}, 'match');

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('DeviceNotRegistered → nullify push_token with race-protection guard', async () => {
    const token = 'ExponentPushToken[STALE]';
    pool.query
      .mockResolvedValueOnce({ rows: [{ push_token: token, notification_preferences: {} }] })
      .mockResolvedValueOnce({ rows: [] });
    global.fetch = jest.fn().mockResolvedValue({
      json: () => Promise.resolve({
        data: { status: 'error', message: 'Stale', details: { error: 'DeviceNotRegistered' } },
      }),
    });

    await sendPushToUser('user-1', 'Test', 'Body');

    expect(pool.query).toHaveBeenCalledTimes(2);
    const updateSql    = pool.query.mock.calls[1][0];
    const updateParams = pool.query.mock.calls[1][1];
    expect(updateSql).toContain('SET push_token = NULL');
    expect(updateSql).toContain('AND push_token = $2');
    expect(updateParams).toEqual(['user-1', token]);
  });

  test('Other Expo error (MessageTooBig) → no nullify', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ push_token: 'ExponentPushToken[OK]', notification_preferences: {} }],
    });
    global.fetch = jest.fn().mockResolvedValue({
      json: () => Promise.resolve({
        data: { status: 'error', message: 'Big', details: { error: 'MessageTooBig' } },
      }),
    });

    await sendPushToUser('user-1', 'Test', 'Body');

    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});
