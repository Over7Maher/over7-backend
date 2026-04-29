jest.mock('cloudinary', () => ({
  v2: {
    config: jest.fn(),
    uploader: { upload_stream: jest.fn() },
    api: {
      delete_resources_by_prefix: jest.fn(),
      delete_folder: jest.fn(),
    },
  },
}));

const { v2: cloudinaryMock } = require('cloudinary');
const { deleteUserPhotos } = require('../cloudinary');

describe('deleteUserPhotos', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  test('3 photos deleted + folder removed → returns counts', async () => {
    cloudinaryMock.api.delete_resources_by_prefix.mockResolvedValueOnce({
      deleted: {
        'over7/users/u1/p1': 'deleted',
        'over7/users/u1/p2': 'deleted',
        'over7/users/u1/p3': 'deleted',
      },
    });
    cloudinaryMock.api.delete_folder.mockResolvedValueOnce({});

    const result = await deleteUserPhotos('u1');

    expect(result).toEqual({ deleted: 3, folderRemoved: true });
    expect(cloudinaryMock.api.delete_resources_by_prefix).toHaveBeenCalledWith('over7/users/u1/');
    expect(cloudinaryMock.api.delete_folder).toHaveBeenCalledWith('over7/users/u1');
  });

  test('Empty folder (0 photos) → deleted count = 0, folder still attempted', async () => {
    cloudinaryMock.api.delete_resources_by_prefix.mockResolvedValueOnce({ deleted: {} });
    cloudinaryMock.api.delete_folder.mockResolvedValueOnce({});

    const result = await deleteUserPhotos('u1');

    expect(result).toEqual({ deleted: 0, folderRemoved: true });
    expect(cloudinaryMock.api.delete_folder).toHaveBeenCalledTimes(1);
  });

  test('Folder delete fails → folderRemoved=false, no throw', async () => {
    cloudinaryMock.api.delete_resources_by_prefix.mockResolvedValueOnce({
      deleted: { 'over7/users/u1/p1': 'deleted' },
    });
    cloudinaryMock.api.delete_folder.mockRejectedValueOnce(new Error('Folder not empty'));

    const result = await deleteUserPhotos('u1');

    expect(result.deleted).toBe(1);
    expect(result.folderRemoved).toBe(false);
  });

  test('Resource delete fails → throws (caller handles)', async () => {
    cloudinaryMock.api.delete_resources_by_prefix.mockRejectedValueOnce(
      new Error('Cloudinary API down')
    );

    await expect(deleteUserPhotos('u1')).rejects.toThrow('Cloudinary API down');
    expect(cloudinaryMock.api.delete_folder).not.toHaveBeenCalled();
  });

  test('Response missing "deleted" key → counts as 0', async () => {
    cloudinaryMock.api.delete_resources_by_prefix.mockResolvedValueOnce({});
    cloudinaryMock.api.delete_folder.mockResolvedValueOnce({});

    const result = await deleteUserPhotos('u1');

    expect(result.deleted).toBe(0);
    expect(result.folderRemoved).toBe(true);
  });

  test('Null response → counts as 0 (no NPE on Object.keys(null))', async () => {
    cloudinaryMock.api.delete_resources_by_prefix.mockResolvedValueOnce(null);
    cloudinaryMock.api.delete_folder.mockResolvedValueOnce({});

    const result = await deleteUserPhotos('u1');

    expect(result.deleted).toBe(0);
  });
});
