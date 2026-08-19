/**
 * Workers berjalan di UTC secara internal, tapi V8 di Workers sudah include
 * data timezone lengkap (ICU) - jadi Intl.DateTimeFormat dengan timeZone
 * 'Asia/Jakarta' akurat tanpa perlu hitung offset manual, padanan langsung
 * dari Utilities.formatDate(now, 'Asia/Jakarta', ...) di Apps Script.
 */
export function nowJakarta() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(now);

  const map = {};
  parts.forEach((p) => { map[p.type] = p.value; });

  const dateStr = `${map.year}-${map.month}-${map.day}`;
  const timeStr = `${map.hour}:${map.minute}`;

  const weekdayShort = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jakarta', weekday: 'short'
  }).format(now);
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return { dateStr, timeStr, dayOfWeek: dayMap[weekdayShort] };
}
