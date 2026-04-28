describe('Jest sanity', () => {
  test('1 + 1 = 2', () => {
    expect(1 + 1).toBe(2);
  });

  test('strings work', () => {
    expect('hello'.toUpperCase()).toBe('HELLO');
  });

  test('arrays work', () => {
    expect([1, 2, 3]).toContain(2);
  });
});
