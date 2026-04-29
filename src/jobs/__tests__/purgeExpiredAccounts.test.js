jest.mock('../../db/pool', () => ({
  query: jest.fn(),
}));
jest.mock('../../services/cloudinary', () => ({
  deleteUserPhotos: jest.fn(),
}));

const pool = require('../../db/pool');
const { deleteUserPhotos } = require('../../services/cloudinary');
const { purgeExpiredAccounts } = require('../purgeExpiredAccounts');

describe('purgeExpiredAccounts', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  test('No accounts to purge → no-op', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await purgeExpiredAccounts();

    expect(result).toEqual({ purged: 0 });
    expect(deleteUserPhotos).not.toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('Single account → cloudinary cleanup + DELETE', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] })
      .mockResolvedValueOnce({ rows: [] });
    deleteUserPhotos.mockResolvedValueOnce({ deleted: 3, folderRemoved: true });

    const result = await purgeExpiredAccounts();

    expect(result).toEqual({ purged: 1, attempted: 1 });
    expect(deleteUserPhotos).toHaveBeenCalledWith('user-1');
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[1][0]).toContain('DELETE FROM users');
    expect(pool.query.mock.calls[1][1]).toEqual(['user-1']);
  });

  test('Multiple accounts → each is processed', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }] })
      .mockResolvedValue({ rows: [] });
    deleteUserPhotos.mockResolvedValue({ deleted: 0, folderRemoved: false });

    const result = await purgeExpiredAccounts();

    expect(result.purged).toBe(3);
    expect(result.attempted).toBe(3);
    expect(deleteUserPhotos).toHaveBeenCalledTimes(3);
    expect(deleteUserPhotos).toHaveBeenNthCalledWith(1, 'u1');
    expect(deleteUserPhotos).toHaveBeenNthCalledWith(2, 'u2');
    expect(deleteUserPhotos).toHaveBeenNthCalledWith(3, 'u3');
  });

  test('Cloudinary failure → DB DELETE still proceeds (orphan assets accepted)', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] })
      .mockResolvedValueOnce({ rows: [] });
    deleteUserPhotos.mockRejectedValueOnce(new Error('Cloudinary API down'));

    const result = await purgeExpiredAccounts();

    expect(result.purged).toBe(1);
    expect(pool.query.mock.calls[1][0]).toContain('DELETE FROM users');
    expect(pool.query.mock.calls[1][1]).toEqual(['user-1']);
  });

  test('DB DELETE failure on one user → skip + continue with next', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 'u1' }, { id: 'u2' }] })
      .mockRejectedValueOnce(new Error('DB error'))
      .mockResolvedValueOnce({ rows: [] });
    deleteUserPhotos.mockResolvedValue({ deleted: 0, folderRemoved: false });

    const result = await purgeExpiredAccounts();

    expect(result.purged).toBe(1);
    expect(result.attempted).toBe(2);
    expect(deleteUserPhotos).toHaveBeenCalledTimes(2);
  });

  test('SELECT uses INTERVAL 30 days + is_active=FALSE + deleted_at filter', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await purgeExpiredAccounts();

    const sql = pool.query.mock.calls[0][0];
    expect(sql).toMatch(/INTERVAL '30 days'/);
    expect(sql).toMatch(/is_active = FALSE/);
    expect(sql).toMatch(/deleted_at IS NOT NULL/);
    expect(sql).toMatch(/deleted_at < NOW\(\)/);
  });

  test('LIMIT 100 (BATCH_SIZE) applied as parameterized arg', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await purgeExpiredAccounts();

    expect(pool.query.mock.calls[0][0]).toContain('LIMIT $1');
    expect(pool.query.mock.calls[0][1]).toEqual([100]);
  });
});
