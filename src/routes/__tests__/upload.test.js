const mockVerifyIdToken = jest.fn();
const mockUploadPhoto   = jest.fn();

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
jest.mock('../../services/cloudinary', () => ({
  uploadPhoto:      (...args) => mockUploadPhoto(...args),
  deleteUserPhotos: jest.fn(),
}));

const request = require('supertest');
const app  = require('../../app');
const pool = require('../../db/pool');

const USER_ID = '550e8400-e29b-41d4-a716-446655440000';

const ACTIVE_USER = {
  id:           USER_ID,
  firebase_uid: 'fbuid-uploader',
  email:        'me@example.com',
  name:         'Me',
  is_active:    true,
};

function mockAuthOk(overrides = {}) {
  mockVerifyIdToken.mockResolvedValueOnce({ uid: ACTIVE_USER.firebase_uid });
  pool.query.mockResolvedValueOnce({ rows: [{ ...ACTIVE_USER, ...overrides }] });
}

// Tiny valid-ish JPEG byte sequence — multer's memoryStorage accepts any
// buffer; the mimetype filter checks the Content-Type header that supertest
// sends via .attach(file, { contentType }).
const FAKE_JPEG = Buffer.from('fake-jpeg-bytes');

describe('POST /api/upload/photo', () => {
  beforeEach(() => jest.resetAllMocks());

  test('Missing Authorization → 401', async () => {
    const res = await request(app)
      .post('/api/upload/photo')
      .attach('photo', FAKE_JPEG, { filename: 'test.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(401);
  });

  test('No file attached → 400', async () => {
    mockAuthOk();
    const res = await request(app)
      .post('/api/upload/photo')
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no file/i);
  });

  test('Disallowed mimetype (image/gif) → next(err) via Multer fileFilter', async () => {
    mockAuthOk();
    const res = await request(app)
      .post('/api/upload/photo')
      .set('Authorization', 'Bearer t')
      .attach('photo', FAKE_JPEG, { filename: 'test.gif', contentType: 'image/gif' });

    // MulterError lacks a status property → errorHandler falls back to 500.
    expect(res.status).toBe(500);
    expect(mockUploadPhoto).not.toHaveBeenCalled();
  });

  test('Nominal upload → 201 + uploadPhoto called with (buffer, auth user id)', async () => {
    mockAuthOk();
    mockUploadPhoto.mockResolvedValueOnce('https://cdn.cloudinary.com/over7/users/u1/p1.jpg');

    const res = await request(app)
      .post('/api/upload/photo')
      .set('Authorization', 'Bearer t')
      .attach('photo', FAKE_JPEG, { filename: 'test.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);
    expect(res.body.url).toBe('https://cdn.cloudinary.com/over7/users/u1/p1.jpg');

    expect(mockUploadPhoto).toHaveBeenCalledTimes(1);
    const [bufferArg, userIdArg] = mockUploadPhoto.mock.calls[0];
    expect(Buffer.isBuffer(bufferArg)).toBe(true);
    // Anti-tampering: user id is the auth user, never anything from the request body.
    expect(userIdArg).toBe(USER_ID);
  });

  test('Cloudinary upload throws → 500 via errorHandler', async () => {
    mockAuthOk();
    mockUploadPhoto.mockRejectedValueOnce(new Error('Cloudinary down'));

    const res = await request(app)
      .post('/api/upload/photo')
      .set('Authorization', 'Bearer t')
      .attach('photo', FAKE_JPEG, { filename: 'test.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(500);
  });

  test('image/png mimetype is accepted', async () => {
    mockAuthOk();
    mockUploadPhoto.mockResolvedValueOnce('https://cdn/over7/u1/p.png');

    const res = await request(app)
      .post('/api/upload/photo')
      .set('Authorization', 'Bearer t')
      .attach('photo', FAKE_JPEG, { filename: 'test.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
  });

  test('image/webp mimetype is accepted', async () => {
    mockAuthOk();
    mockUploadPhoto.mockResolvedValueOnce('https://cdn/over7/u1/p.webp');

    const res = await request(app)
      .post('/api/upload/photo')
      .set('Authorization', 'Bearer t')
      .attach('photo', FAKE_JPEG, { filename: 'test.webp', contentType: 'image/webp' });

    expect(res.status).toBe(201);
  });
});

describe('POST /api/upload/photos', () => {
  beforeEach(() => jest.resetAllMocks());

  test('No files attached → 400', async () => {
    mockAuthOk();
    const res = await request(app)
      .post('/api/upload/photos')
      .set('Authorization', 'Bearer t');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no files/i);
  });

  test('Nominal multi-upload → 201 + uploadPhoto called once per file with auth user id', async () => {
    mockAuthOk();
    mockUploadPhoto
      .mockResolvedValueOnce('https://cdn/over7/u1/a.jpg')
      .mockResolvedValueOnce('https://cdn/over7/u1/b.jpg')
      .mockResolvedValueOnce('https://cdn/over7/u1/c.jpg');

    const res = await request(app)
      .post('/api/upload/photos')
      .set('Authorization', 'Bearer t')
      .attach('photos', FAKE_JPEG, { filename: 'a.jpg', contentType: 'image/jpeg' })
      .attach('photos', FAKE_JPEG, { filename: 'b.jpg', contentType: 'image/jpeg' })
      .attach('photos', FAKE_JPEG, { filename: 'c.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);
    expect(res.body.urls).toEqual([
      'https://cdn/over7/u1/a.jpg',
      'https://cdn/over7/u1/b.jpg',
      'https://cdn/over7/u1/c.jpg',
    ]);

    expect(mockUploadPhoto).toHaveBeenCalledTimes(3);
    // Anti-tampering: every call uses auth user id, never something from body.
    mockUploadPhoto.mock.calls.forEach(([, userIdArg]) => {
      expect(userIdArg).toBe(USER_ID);
    });
  });

  test('Disallowed mimetype on one of the files → 500 via Multer fileFilter', async () => {
    mockAuthOk();
    const res = await request(app)
      .post('/api/upload/photos')
      .set('Authorization', 'Bearer t')
      .attach('photos', FAKE_JPEG, { filename: 'a.jpg', contentType: 'image/jpeg' })
      .attach('photos', FAKE_JPEG, { filename: 'bad.gif', contentType: 'image/gif' });

    expect(res.status).toBe(500);
    expect(mockUploadPhoto).not.toHaveBeenCalled();
  });
});
