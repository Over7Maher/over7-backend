// Slot utilities — Speed Date time-of-day logic, Europe/Brussels timezone.
// Extracted from src/routes/speedDate.js so other routes (likes, matches,
// notifications) can reuse the same source of truth.

// Returns today's YYYY-MM-DD in Europe/Brussels. 'en-CA' locale conveniently
// formats as YYYY-MM-DD, so slicing the first 10 chars is safe.
function todayBrussels() {
  return new Date().toLocaleString('en-CA', { timeZone: 'Europe/Brussels' }).slice(0, 10);
}

// Returns the current hour (0-23) in Europe/Brussels.
function brusselsHour() {
  return new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Europe/Brussels' })
  ).getHours();
}

// Adds `days` calendar days to a YYYY-MM-DD string. Treats the input as UTC
// midnight so arithmetic doesn't cross DST boundaries unintentionally.
function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Returns the currently-active slot in Europe/Brussels, or null when outside
// both windows. afternoon = [14h, 18h), evening = [19h, 23h).
function getCurrentSlot() {
  const hour = brusselsHour();
  const slotDate = todayBrussels();

  if (hour >= 14 && hour < 18) return { slot_type: 'afternoon', slot_date: slotDate };
  if (hour >= 19 && hour < 23) return { slot_type: 'evening',   slot_date: slotDate };
  return null;
}

// Returns today's slot types that have not yet ended, in Europe/Brussels.
// A slot is "live" from 00:00 until its end hour — profiles for an upcoming
// slot (e.g. afternoon before 14h) are still shown.
//   hour < 18 → afternoon still alive
//   hour < 23 → evening still alive
function getLiveSlotsToday() {
  const hour = brusselsHour();
  const slots = [];
  if (hour < 18) slots.push('afternoon');
  if (hour < 23) slots.push('evening');
  return slots;
}

module.exports = {
  todayBrussels,
  brusselsHour,
  addDays,
  getCurrentSlot,
  getLiveSlotsToday,
};
