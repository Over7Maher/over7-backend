const mockVerifyIdToken = jest.fn();

jest.mock('../../services/firebaseAdmin', () => () => ({
  auth: () => ({
    verifyIdToken: mockVerifyIdToken,
  }),
}));
jest.mock('../../db/pool', () => ({
  query: jest.fn(),
}));

const auth = require('../auth');
const pool = require('../../db/pool');

function mockReqRes(authHeader) {
  const req  = { headers: { authorization: authHeader } };
  const res  = {
    status: jest.fn().mockReturnThis(),
    json:   jest.fn().mockReturnThis(),
  };
  const next = jest.fn();
  return { req, res, next };
}

describe('auth middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('Missing Authorization header → 401', async () => {
    const { req, res, next } = mockReqRes(undefined);

    await auth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
    expect(next).not.toHaveBeenCalled();
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  test('Malformed header (not Bearer) → 401', async () => {
    const { req, res, next } = mockReqRes('NotBearer xyz');

    await auth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  test('Expired token (auth/id-token-expired) → 401 "Token expired"', async () => {
    const { req, res, next } = mockReqRes('Bearer expired-token');
    const err = Object.assign(new Error('Expired'), { code: 'auth/id-token-expired' });
    mockVerifyIdToken.mockRejectedValueOnce(err);

    await auth(req, res, next);

    expect(mockVerifyIdToken).toHaveBeenCalledWith('expired-token');
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0].error).toMatch(/expired/i);
    expect(next).not.toHaveBeenCalled();
  });

  test('Invalid token (auth/argument-error) → 401 "Invalid token"', async () => {
    const { req, res, next } = mockReqRes('Bearer fake-token');
    const err = Object.assign(new Error('Bad'), { code: 'auth/argument-error' });
    mockVerifyIdToken.mockRejectedValueOnce(err);

    await auth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0].error).toMatch(/invalid/i);
    expect(next).not.toHaveBeenCalled();
  });

  test('Revoked token (auth/id-token-revoked) → 401 "Invalid token"', async () => {
    const { req, res, next } = mockReqRes('Bearer revoked-token');
    const err = Object.assign(new Error('Revoked'), { code: 'auth/id-token-revoked' });
    mockVerifyIdToken.mockRejectedValueOnce(err);

    await auth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0].error).toMatch(/invalid/i);
  });

  test('Unknown verifyIdToken error → next(err) (forwarded to error handler)', async () => {
    const { req, res, next } = mockReqRes('Bearer mystery-token');
    const err = new Error('Network down');
    mockVerifyIdToken.mockRejectedValueOnce(err);

    await auth(req, res, next);

    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(err);
  });

  test('Valid token + active user in DB → next() called, req.user populated', async () => {
    const { req, res, next } = mockReqRes('Bearer valid-token');
    mockVerifyIdToken.mockResolvedValueOnce({ uid: 'fbuid-123' });
    const userRow = { id: 'user-uuid-1', firebase_uid: 'fbuid-123', is_active: true, name: 'Alice' };
    pool.query.mockResolvedValueOnce({ rows: [userRow] });

    await auth(req, res, next);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM users'),
      ['fbuid-123'],
    );
    expect(req.user).toEqual(userRow);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('Valid token but user row not returned (not registered or is_active=FALSE filtered by SQL) → 401', async () => {
    const { req, res, next } = mockReqRes('Bearer valid-token');
    mockVerifyIdToken.mockResolvedValueOnce({ uid: 'fbuid-ghost' });
    pool.query.mockResolvedValueOnce({ rows: [] });

    await auth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0].error).toMatch(/not found|inactive/i);
    expect(next).not.toHaveBeenCalled();
  });

  test('SQL filters AND is_active = TRUE (server-side enforcement)', async () => {
    const { req, res, next } = mockReqRes('Bearer valid-token');
    mockVerifyIdToken.mockResolvedValueOnce({ uid: 'fbuid-1' });
    pool.query.mockResolvedValueOnce({ rows: [] });

    await auth(req, res, next);

    const sql = pool.query.mock.calls[0][0];
    expect(sql).toContain('firebase_uid = $1');
    expect(sql).toContain('is_active = TRUE');
  });
});
