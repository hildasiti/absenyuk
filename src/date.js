/**
 * Workers berjalan di UTC secara internal, tapi V8 di Workers sudah include
 * data timezone lengkap (ICU) - jadi Intl.DateTimeFormat dengan timeZone
 * 'Asia/Jakarta' akurat tanpa perlu hitung offset manual.
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

/**
 * Periode payroll (siklus tanggal 21-20) yang digeser `offset` periode dari
 * periode berjalan: 0 = berjalan, -1 = sebelumnya, -2 = dua periode lalu, dst.
 * Dihitung lewat "indeks bulan absolut" (tahun*12 + bulan 0-indexed) supaya
 * pergantian tahun (Des-Jan) otomatis benar tanpa if/else khusus.
 */
export function getPeriodeByOffset(offset = 0) {
  const { year: tahun, month: bulan1, day: tanggal } = nowJakarta();

  // Bulan AKHIR periode berjalan: bulan ini kalau tanggal < 21, bulan depan kalau >= 21.
  let endIdx = tahun * 12 + (bulan1 - 1) + (tanggal >= 21 ? 1 : 0);
  endIdx += offset;
  const startIdx = endIdx - 1;

  const endTahun = Math.floor(endIdx / 12);
  const endBulan = ((endIdx % 12) + 12) % 12;
  const startTahun = Math.floor(startIdx / 12);
  const startBulan = ((startIdx % 12) + 12) % 12;

  const start = new Date(Date.UTC(startTahun, startBulan, 21, 0, 0, 0));
  const end = new Date(Date.UTC(endTahun, endBulan, 20, 23, 59, 59));
  const label = `21 ${NAMA_BULAN[startBulan]} - 20 ${NAMA_BULAN[endBulan]} ${endTahun}`;
  return { start, end, label };
}

/** Padanan getPeriodeBerjalan() - siklus payroll tanggal 21-20. */
export function getPeriodeBerjalan() {
  return getPeriodeByOffset(0);
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
