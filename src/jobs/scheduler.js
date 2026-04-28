const cron = require('node-cron');
const { purgeExpiredAccounts } = require('./purgeExpiredAccounts');

/**
 * Schedules all background jobs. Called once at server boot from
 * src/app.js after the HTTP server is listening.
 *
 * Currently scheduled:
 *   - RGPD purge: every day at 02:30 UTC (low-traffic window)
 *
 * node-cron syntax: 'min hour day month weekday' → '30 2 * * *'
 */
function scheduleJobs() {
  cron.schedule('30 2 * * *', async () => {
    try {
      await purgeExpiredAccounts();
    } catch (err) {
      console.error('[cron] purgeExpiredAccounts crashed:', err);
    }
  }, {
    timezone: 'UTC',
  });

  console.log('[cron] scheduled jobs registered');
}

module.exports = { scheduleJobs };
