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

  return {
    dateStr, timeStr, dayOfWeek: dayMap[weekdayShort],
    year: parseInt(map.year, 10), month: parseInt(map.month, 10), day: parseInt(map.day, 10)
  };
}

const NAMA_BULAN = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];

/** Padanan getPeriodeBerjalan() - siklus payroll tanggal 21-20. */
export function getPeriodeBerjalan() {
  const { year: tahun, month: bulan1, day: tanggal } = nowJakarta();
  const bulan = bulan1 - 1; // ke 0-indexed biar sama seperti kode lama

  let startBulan, startTahun, endBulan, endTahun;
  if (tanggal >= 21) {
    startBulan = bulan; startTahun = tahun;
    endBulan = bulan + 1; endTahun = tahun;
  } else {
    startBulan = bulan - 1; startTahun = tahun;
    endBulan = bulan; endTahun = tahun;
  }
  if (startBulan < 0) { startBulan = 11; startTahun -= 1; }
  if (endBulan > 11) { endBulan = 0; endTahun += 1; }

  const start = new Date(Date.UTC(startTahun, startBulan, 21, 0, 0, 0));
  const end = new Date(Date.UTC(endTahun, endBulan, 20, 23, 59, 59));
  const label = `21 ${NAMA_BULAN[startBulan]} - 20 ${NAMA_BULAN[endBulan]} ${endTahun}`;
  return { start, end, label };
}

/** Padanan getMingguIniSeninJumat() - rentang Senin-Jumat minggu berjalan. */
export function getMingguIniSeninJumat() {
  const { year, month, day, dayOfWeek } = nowJakarta();
  const todayUTC = new Date(Date.UTC(year, month - 1, day));
  const offsetKeSenin = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;

  const senin = new Date(todayUTC);
  senin.setUTCDate(todayUTC.getUTCDate() + offsetKeSenin);
  senin.setUTCHours(0, 0, 0, 0);

  const jumat = new Date(senin);
  jumat.setUTCDate(senin.getUTCDate() + 4);
  jumat.setUTCHours(23, 59, 59, 999);

  const labelSenin = `${senin.getUTCDate()} ${NAMA_BULAN[senin.getUTCMonth()]}`;
  const labelJumat = `${jumat.getUTCDate()} ${NAMA_BULAN[jumat.getUTCMonth()]} ${jumat.getUTCFullYear()}`;
  const label = `Minggu Ini (${labelSenin} - ${labelJumat})`;

  return { start: senin, end: jumat, label };
}

/** Format tanggal (Date object, dianggap sudah UTC-normalized) jadi 'yyyy-MM-dd'. */
export function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}
