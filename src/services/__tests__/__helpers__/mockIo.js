/**
 * Returns a mock io object that supports the chainable
 * io.to(roomId).emit(event, payload) pattern used throughout the codebase.
 *
 * Both `to` and `emit` are jest.fn() so tests can assert on:
 *   - which room was targeted: expect(io.to).toHaveBeenCalledWith('user:X')
 *   - what was emitted:        expect(io.emit).toHaveBeenCalledWith('event', payload)
 *
 * `emit` is reused across every io.to(...) call, so you can assert directly
 * on the top-level io.emit without juggling chained returns.
 */
function mockIo() {
  const emit = jest.fn();
  const to = jest.fn(() => ({ emit }));
  return { to, emit };
}

module.exports = { mockIo };
