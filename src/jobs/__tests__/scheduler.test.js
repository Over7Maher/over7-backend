jest.mock('node-cron', () => ({
  schedule: jest.fn(),
}));
jest.mock('../purgeExpiredAccounts', () => ({
  purgeExpiredAccounts: jest.fn(),
}));

const cron = require('node-cron');
const { purgeExpiredAccounts } = require('../purgeExpiredAccounts');
const { scheduleJobs } = require('../scheduler');

describe('scheduleJobs', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  test('Registers exactly one cron job', () => {
    scheduleJobs();
    expect(cron.schedule).toHaveBeenCalledTimes(1);
  });

  test('Cron expression = 02:30 UTC daily', () => {
    scheduleJobs();
    const [expression, , options] = cron.schedule.mock.calls[0];
    expect(expression).toBe('30 2 * * *');
    expect(options).toEqual({ timezone: 'UTC' });
  });

  test('Callback invokes purgeExpiredAccounts', async () => {
    scheduleJobs();
    const callback = cron.schedule.mock.calls[0][1];
    purgeExpiredAccounts.mockResolvedValueOnce({ purged: 0 });

    await callback();

    expect(purgeExpiredAccounts).toHaveBeenCalledTimes(1);
  });

  test('Callback swallows purgeExpiredAccounts crashes (does not propagate)', async () => {
    scheduleJobs();
    const callback = cron.schedule.mock.calls[0][1];
    purgeExpiredAccounts.mockRejectedValueOnce(new Error('DB down'));

    await expect(callback()).resolves.not.toThrow();
  });
});
