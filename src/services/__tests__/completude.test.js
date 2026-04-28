const { calculateCompletude, completudeBreakdown } = require('../completude');

// Builds a user object satisfying every item in the completude grid, so the
// total reaches the 100 cap. Used as the maxed-out reference and as a base
// for negative tests (set one field to invalid → confirm the delta).
function fullUser() {
  return {
    profile_picture_url: 'main.jpg',
    photos: ['p1.jpg', 'p2.jpg', 'p3.jpg'],   // totalPhotos = 4 (>=3)
    bio: 'Some bio text',
    relation_type: 'serious',
    tags: ['t1', 't2', 't3'],                  // length >= 3
    height_cm: 180,
    languages: ['fr'],
    astro_sign: 'gemini',
    education: 'master',
    family_plans: 'maybe',
    communication_style: 'direct',
    love_language: 'words',
    pet: 'dog',
    alcohol: 'sometimes',
    tobacco: 'never',
    sport: 'often',
    evenings_type: 'chill',
    weekends_type: 'active',
    social_media: 'rare',
    job_title: 'engineer',
    company: 'over7',
    favorite_song: 'a song',
  };
}

describe('calculateCompletude', () => {
  test('Empty profile → 0', () => {
    expect(calculateCompletude({})).toBe(0);
  });

  test('Single photo via photos[] → 10', () => {
    expect(calculateCompletude({ photos: ['p1.jpg'] })).toBe(10);
  });

  test('Single photo via profile_picture_url → 10', () => {
    expect(calculateCompletude({ profile_picture_url: 'main.jpg' })).toBe(10);
  });

  test('3 photos (no profile_picture_url) → 15 (10 + 5)', () => {
    expect(calculateCompletude({ photos: ['p1.jpg', 'p2.jpg', 'p3.jpg'] })).toBe(15);
  });

  test('profile_picture_url + 2 photos → 15 (cumulé = 3)', () => {
    expect(calculateCompletude({
      profile_picture_url: 'main.jpg',
      photos: ['p1.jpg', 'p2.jpg'],
    })).toBe(15);
  });

  test('Full profile + promptsCount=3 → 100 (capped)', () => {
    expect(calculateCompletude(fullUser(), 3)).toBe(100);
  });

  test('promptsCount = 0 → no prompts bonus', () => {
    expect(calculateCompletude({ photos: ['p1.jpg'] }, 0)).toBe(10);
  });

  test('promptsCount = 2 → no prompts bonus (threshold is 3)', () => {
    expect(calculateCompletude({ photos: ['p1.jpg'] }, 2)).toBe(10);
  });

  test('promptsCount = 3 → +7 prompts bonus', () => {
    expect(calculateCompletude({ photos: ['p1.jpg'] }, 3)).toBe(17);
  });

  test('promptsCount default (omitted) → no bonus', () => {
    expect(calculateCompletude({ photos: ['p1.jpg'] })).toBe(10);
  });

  test('tags = null → no NPE, tags not counted', () => {
    expect(() => calculateCompletude({ photos: ['p1.jpg'], tags: null })).not.toThrow();
    expect(calculateCompletude({ photos: ['p1.jpg'], tags: null })).toBe(10);
  });

  test('tags = [] (empty) → not counted (< 3)', () => {
    expect(calculateCompletude({ photos: ['p1.jpg'], tags: [] })).toBe(10);
  });

  test('tags = 3 items → +5 bonus', () => {
    expect(calculateCompletude({ photos: ['p1.jpg'], tags: ['a', 'b', 'c'] })).toBe(15);
  });

  test('height_cm = 0 → not counted (guard > 0)', () => {
    expect(calculateCompletude({ photos: ['p1.jpg'], height_cm: 0 })).toBe(10);
  });

  test('height_cm = 170 → +3 bonus', () => {
    expect(calculateCompletude({ photos: ['p1.jpg'], height_cm: 170 })).toBe(13);
  });

  test('bio whitespace only → not counted (trim falsy)', () => {
    expect(calculateCompletude({ photos: ['p1.jpg'], bio: '   ' })).toBe(10);
  });

  test('bio non-empty → +10 bonus', () => {
    expect(calculateCompletude({ photos: ['p1.jpg'], bio: 'hello' })).toBe(20);
  });

  test('languages = null → no NPE, not counted', () => {
    expect(() => calculateCompletude({ photos: ['p1.jpg'], languages: null })).not.toThrow();
    expect(calculateCompletude({ photos: ['p1.jpg'], languages: null })).toBe(10);
  });
});

describe('completudeBreakdown', () => {
  test('Returns { pct, items }', () => {
    const result = completudeBreakdown({});
    expect(result).toHaveProperty('pct');
    expect(result).toHaveProperty('items');
    expect(Array.isArray(result.items)).toBe(true);
  });

  test('items contains 23 entries (full grid)', () => {
    const result = completudeBreakdown({});
    expect(result.items.length).toBe(23);
  });

  test('Each item has key/label/pts/done shape', () => {
    const result = completudeBreakdown({});
    for (const item of result.items) {
      expect(item).toHaveProperty('key');
      expect(item).toHaveProperty('label');
      expect(item).toHaveProperty('pts');
      expect(item).toHaveProperty('done');
      expect(typeof item.done).toBe('boolean');
    }
  });

  test('Empty profile → pct = 0, all items done=false', () => {
    const result = completudeBreakdown({});
    expect(result.pct).toBe(0);
    expect(result.items.every(i => i.done === false)).toBe(true);
  });

  test('Full profile + promptsCount=3 → pct = 100, all items done=true', () => {
    const result = completudeBreakdown(fullUser(), 3);
    expect(result.pct).toBe(100);
    expect(result.items.every(i => i.done === true)).toBe(true);
  });

  test('pct matches calculateCompletude on the same input', () => {
    const user = { photos: ['p1.jpg'], bio: 'hi', tags: ['a', 'b', 'c'] };
    const breakdown = completudeBreakdown(user, 3);
    const direct = calculateCompletude(user, 3);
    expect(breakdown.pct).toBe(direct);
  });
});
