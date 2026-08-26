import { sbSelect, sbInsert, sbInsertMany, sbUpdate, sbUpdateWhere, sbDelete } from './supabase.js';
import { createSession, getSession, destroySession } from './session.js';
import { verifyAndMigratePassword } from './auth.js';
import { getSettingsMap } from './settings.js';
import { checkApakahHariLibur, hitungRadiusGPS } from './libur.js';
import { nowJakarta, getPeriodeBerjalan, getMingguIniSeninJumat, toDateStr } from './date.js';
import { cached, invalidate } from './cache.js';
import { kirimNotifikasiKeSatuHP } from './fcm.js';

function generateShortID(prefix) {
  const karakter = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let hasil = '';
  for (let i = 0; i < 6; i++) hasil += karakter.charAt(Math.floor(Math.random() * karakter.length));
  return prefix + '_' + hasil;
}

async function requireUser(env, token) {
  return getSession(env, token);
}

function isRole(user, ...roles) {
  return !!user && roles.includes(String(user.role).trim());
}

/** Admin Sekolah maupun Admin Utama, keduanya punya hak admin. */
function isAdminAny(user) {
  return isRole(user, 'ADMIN_SEKOLAH', 'ADMIN_UTAMA');
}

/**
 * Tentukan sekolah_id yang dipakai untuk query.
 * - Admin Sekolah / Piket / Kepala Sekolah / Guru: SELALU dipaksa pakai
 *   sekolah_id milik akun mereka sendiri, TIDAK PEDULI nilai yang
 *   dikirim dari frontend (supaya 1 sekolah tidak pernah bisa
 *   mengintip/mengubah data sekolah lain walau request dimanipulasi).
 * - Admin Utama: mengelola lintas sekolah, WAJIB pilih sekolah dulu di
 *   frontend (dikirim lewat parameter requestedSekolahId).
 */
function resolveSekolahId(user, requestedSekolahId) {
  if (user.role === 'ADMIN_UTAMA') {
    if (!requestedSekolahId) throw new Error('Admin Utama harus memilih sekolah dulu.');
    return requestedSekolahId;
  }
  return user.sekolahId;
}

async function getUsersListCached(env, sekolahId) {
  return cached(env, `USERS_CACHE_${sekolahId}`, 180, () => sbSelect(env, 'users', `sekolah_id=eq.${sekolahId}`));
}
async function getLiburListCached(env, sekolahId) {
  return cached(env, `LIBUR_CACHE_${sekolahId}`, 600, () => sbSelect(env, 'libur_nasional', `sekolah_id=eq.${sekolahId}`));
}
async function getJadwalKegiatanCached(env, sekolahId) {
  return cached(env, `JADWAL_KEGIATAN_CACHE_${sekolahId}`, 60, () => sbSelect(env, 'jadwal_kegiatan', `sekolah_id=eq.${sekolahId}`));
}

// Konfigurasi jenis laporan/kegiatan (9 jenis majelis/kegiatan rutin yang identik strukturnya).
// CATATAN: Qini Nasional sengaja dipecah jadi 2 "jenis kegiatan" terpisah (Subuh & Malam) -
// BUKAN 1 jenis dengan 2x absen per hari - supaya kunci anti-absen-ganda (yang selama ini
// bekerja per kombinasi jenis_kegiatan + tanggal) otomatis mengizinkan 1x absen Subuh DAN
// 1x absen Malam di tanggal yang sama (Jumat, Sabtu), tapi tetap menolak absen ganda di
// sesi yang sama. Total 4 hari kegiatan (Kamis-Ahad) x sesi yang relevan = 6 kali absen:
// Kamis malam, Jumat subuh, Jumat malam, Sabtu subuh, Sabtu malam, Ahad subuh.
const KEGIATAN_IDENTIK = [
  'BRIEFING_TAWASUL', 'PENDAMPINGAN_DHUHA', 'SHOLAT_DZUHUR', 'SHOLAT_ASHAR',
  'DZIKIR_MAKHSUS', 'PENGAJIAN_AHAD', 'PENGAJIAN_ARBAIN', 'QINI_NASIONAL_SUBUH', 'QINI_NASIONAL_MALAM'
];

const REPORT_CONFIG = {
  ABSEN_MASUK: {
    table: 'absen_masuk',
    headers: ['ID', 'Tanggal', 'NUPTK', 'Nama', 'Jam', 'Latitude', 'Longitude', 'Jarak (m)', 'Status', 'Keterangan', 'Maps Link'],
    fields: ['id', 'tanggal', 'nuptk', 'nama', 'jam', 'latitude', 'longitude', 'jarak', 'status', 'keterangan', 'maps_link'],
    dateField: 'tanggal', sortField: 'jam'
  },
  ABSEN_KEGIATAN_KHUSUS: {
    table: 'absen_kegiatan_khusus',
    headers: ['ID', 'Tanggal Lapor', 'Waktu Lapor', 'NUPTK', 'Nama', 'Nama Kegiatan', 'Status Kehadiran', 'Catatan', 'Latitude', 'Longitude', 'Jarak (m)'],
    fields: ['id', 'tanggal_lapor', 'waktu_lapor', 'nuptk', 'nama', 'nama_kegiatan', 'status_kehadiran', 'catatan', 'latitude', 'longitude', 'jarak'],
    dateField: 'tanggal_lapor', sortField: 'waktu_lapor'
  },
  REKAP_JAM_PELAJARAN: {
    table: 'rekap_jam_pelajaran',
    headers: ['ID', 'Tanggal', 'NUPTK', 'Nama Guru', 'Jam Ke', 'Status', 'Guru Impal', 'Diinput Oleh', 'Timestamp', 'NUPTK Impal'],
    fields: ['id', 'tanggal', 'nuptk', 'nama_guru', 'jam_ke', 'status', 'guru_impal', 'diinput_oleh', 'timestamp', 'nuptk_impal'],
    dateField: 'tanggal', sortField: 'timestamp'
  }
};
KEGIATAN_IDENTIK.forEach((nama) => {
  REPORT_CONFIG[nama] = {
    table: 'kegiatan_umum', jenisKegiatan: nama,
    headers: ['ID', 'Tanggal', 'NUPTK', 'Nama', 'Kegiatan', 'Status', 'Catatan', 'Timestamp'],
    fields: ['id', 'tanggal', 'nuptk', 'nama', 'kegiatan', 'status', 'catatan', 'timestamp'],
    dateField: 'tanggal', sortField: 'timestamp'
  };
});

const STATUS_ABSEN_VALID = ['Hadir', 'Terlambat', 'Sakit', 'Izin', 'Tugas Luar', 'Tanpa Keterangan'];

// ====================================================================
// AUTH
// ====================================================================

async function loginUser(args, env) {
  const [nuptk, password] = args;
  if (!nuptk || !password) return { success: false, message: 'NUPTK dan password wajib diisi.' };

  const rows = await sbSelect(env, 'users', `nuptk=eq.${encodeURIComponent(String(nuptk).trim())}&limit=1`);
  const userRow = rows[0];
  if (!userRow) return { success: false, message: 'NUPTK/User atau Password tidak cocok.' };

  const ok = await verifyAndMigratePassword(env, userRow, String(password).trim());
  if (!ok) return { success: false, message: 'NUPTK/User atau Password tidak cocok.' };

  if (String(userRow.status).trim() !== 'Aktif') {
    return { success: false, message: 'Akun Anda dinonaktifkan oleh Admin.' };
  }

  let sekolahNama = '';
  if (userRow.sekolah_id) {
    const sekolahRows = await sbSelect(env, 'sekolah', `id=eq.${encodeURIComponent(userRow.sekolah_id)}&limit=1`);
    sekolahNama = sekolahRows[0] ? sekolahRows[0].nama : '';
  }

  const userObj = {
    id: userRow.legacy_id, nuptk: userRow.nuptk, nama: userRow.nama,
    role: String(userRow.role).trim().toUpperCase().replace(/\s+/g, '_'),
    kategori: userRow.kategori || 'Mengajar',
    sekolahId: userRow.sekolah_id, sekolahNama
  };
  const token = await createSession(env, userObj);
  return { success: true, token, user: userObj };
}

async function checkSessionFn(args, env) {
  const [token] = args;
  return requireUser(env, token);
}

async function logoutFn(args, env) {
  const [token] = args;
  await destroySession(env, token);
  return { success: true };
}

// ====================================================================
// SEKOLAH (khusus Admin Utama - dipakai untuk pemilih sekolah di UI)
// ====================================================================

async function getSekolahList(args, env) {
  const [token] = args;
  const user = await requireUser(env, token);
  if (!isRole(user, 'ADMIN_UTAMA')) return [];
  const rows = await sbSelect(env, 'sekolah', 'order=nama.asc');
  return rows.map((s) => ({ id: s.id, nama: s.nama, status: s.status }));
}

// ====================================================================
// ABSEN MASUK
// ====================================================================

/**
 * Dipakai frontend untuk menampilkan jarak GPS REALTIME (sebelum submit) di form
 * Absen Masuk & Absen Kepesantrenan - supaya guru bisa tahu posisinya sudah cukup
 * dekat atau belum, tanpa harus coba-coba submit dulu (terutama berguna kalau
 * sinyal GPS di area pesantren kurang stabil/presisi).
 * Sengaja dibuka untuk SEMUA role yang login (bukan cuma admin), karena titik
 * koordinat & radius bukan data rahasia - guru memang harus tahu di mana titiknya
 * supaya bisa mendekat.
 */
async function getLokasiAbsenTarget(args, env) {
  const [token] = args;
  const user = await requireUser(env, token);
  if (!user) return { success: false, message: 'Sesi habis, silakan login ulang.' };

  const settings = await getSettingsMap(env, user.sekolahId);
  return {
    success: true,
    sekolah: {
      lat: settings.lat_sekolah ? parseFloat(settings.lat_sekolah) : null,
      lon: settings.long_sekolah ? parseFloat(settings.long_sekolah) : null,
      radius: parseInt(settings.radius || 50, 10)
    },
    pesantren: {
      lat: settings.lat_pesantren ? parseFloat(settings.lat_pesantren) : null,
      lon: settings.long_pesantren ? parseFloat(settings.long_pesantren) : null,
      radius: parseInt(settings.radius_pesantren || 100, 10)
    }
  };
}

async function saveAbsenMasuk(args, env) {
  const [token, status, keterangan, lat, lon] = args;
  const user = await requireUser(env, token);
  if (!user) return { success: false, message: 'Sesi habis, silakan login ulang.' };
  const sekolahId = user.sekolahId; // absen selalu untuk sekolah sendiri, tidak ada skenario admin utama absen

  const { dateStr, timeStr: jamLaporStr, dayOfWeek } = nowJakarta();

  let statusLiburSistem = '';
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    statusLiburSistem = 'Libur Akhir Pekan';
  } else {
    const namaLiburNasional = await checkApakahHariLibur(env, sekolahId, dateStr);
    if (namaLiburNasional) statusLiburSistem = 'Libur Nasional: ' + namaLiburNasional;
  }
  if (statusLiburSistem !== '') {
    return { success: false, message: `Presensi Ditolak! Hari ini sistem dinonaktifkan karena agenda [${statusLiburSistem}].` };
  }

  const existing = await sbSelect(env, 'absen_masuk', `nuptk=eq.${encodeURIComponent(user.nuptk)}&tanggal=eq.${dateStr}&limit=1`);
  if (existing.length > 0) {
    return { success: false, message: `Anda sudah melakukan presensi masuk hari ini pada pukul ${existing[0].jam} WIB.` };
  }

  if (!lat || !lon || lat === '-' || lon === '-') {
    return { success: false, message: 'Gagal memverifikasi koordinat GPS. Pastikan izin lokasi aktif.' };
  }

  const settings = await getSettingsMap(env, sekolahId);
  let finalStatus = status;
  const mapsLink = `https://www.google.com/maps?q=${lat},${lon}`;
  const jarakMeter = hitungRadiusGPS(parseFloat(lat), parseFloat(lon), parseFloat(settings.lat_sekolah), parseFloat(settings.long_sekolah));

  // "Hadir & Tawasul" dianggap identik dengan "Hadir" untuk keperluan validasi GPS,
  // keterlambatan, dan status final yang tersimpan di tabel absen_masuk (supaya rekap
  // payroll/kehadiran yang sudah ada tidak perlu tahu soal Tawasul sama sekali - tetap
  // Hadir/Terlambat seperti biasa). Bedanya cuma: ada efek samping mencatat kehadiran
  // Briefing & Tawasul di bawah, menggantikan absen manual terpisah yang dulu ada.
  const ikutTawasul = status === 'Hadir & Tawasul';
  if (status === 'Hadir' || ikutTawasul) {
    if (jarakMeter > parseInt(settings.radius || 50, 10)) {
      return { success: false, message: `Posisi Anda berada di luar radius sekolah (${jarakMeter} meter). Silakan mendekat ke area sekolah.` };
    }
    const [jamMasukH, jamMasukM] = settings.jam_masuk.split(':').map(Number);
    const [jamLaporH, jamLaporM] = jamLaporStr.split(':').map(Number);
    const menitBatas = jamMasukH * 60 + jamMasukM + parseInt(settings.toleransi || 15, 10);
    const menitLapor = jamLaporH * 60 + jamLaporM;
    finalStatus = menitLapor > menitBatas ? 'Terlambat' : 'Hadir';
  }

  try {
    await sbInsert(env, 'absen_masuk', {
      id: generateShortID('AB'), sekolah_id: sekolahId, tanggal: dateStr, nuptk: user.nuptk, nama: user.nama,
      jam: jamLaporStr, latitude: String(lat), longitude: String(lon), jarak: jarakMeter + ' m',
      status: finalStatus, keterangan: keterangan || '-', maps_link: mapsLink
    });
  } catch (err) {
    if (String(err.message).includes('duplicate key')) {
      return { success: false, message: 'Anda sudah melakukan presensi masuk hari ini.' };
    }
    throw err;
  }
  await invalidate(env, `ABSEN_MASUK_PERIODE_CACHE_${sekolahId}`);

  if (ikutTawasul) {
    // Catat juga sebagai kehadiran Briefing & Tawasul (jenis kegiatan yang sama dengan
    // yang dulu diisi manual lewat menu Kegiatan Sekolah) - supaya laporan Briefing &
    // Tawasul tetap jalan tanpa guru perlu absen 2x. Kalau gagal (mis. race condition
    // duplicate key), jangan sampai membatalkan presensi masuk yang sudah tersimpan -
    // presensi masuk tetap prioritas utama.
    try {
      await sbInsert(env, 'kegiatan_umum', {
        id: generateShortID('K'), sekolah_id: sekolahId, jenis_kegiatan: 'BRIEFING_TAWASUL', tanggal: dateStr,
        nuptk: user.nuptk, nama: user.nama, kegiatan: 'BRIEFING_TAWASUL', status: 'Hadir',
        catatan: 'Otomatis tercatat dari Presensi Masuk (Hadir & Tawasul).', timestamp: new Date().toISOString()
      });
    } catch (err) {
      if (!String(err.message).includes('duplicate key')) console.error('Gagal mencatat kehadiran Briefing & Tawasul otomatis:', err.message);
    }
  }

  let pesanSukses = `Presensi berhasil disimpan pada pukul ${jamLaporStr} WIB.`;
  switch (finalStatus) {
    case 'Hadir': pesanSukses += ' Terimakasih Telah Tepat Waktu. Semoga Allah Lancarkan Kegiatan hari ini!'; break;
    case 'Terlambat': pesanSukses = 'Mari datang lebih pagi untuk menyambut siswa. Jam Absen ' + jamLaporStr + ' WIB.'; break;
    case 'Sakit': pesanSukses += ' Semoga lekas sembuh, Pak/Bu. Jangan lupa konfirmasi Kepala Sekolah.'; break;
    case 'Izin': pesanSukses += ' Terima kasih atas informasinya, jangan lupa konfirmasi Kepala Sekolah.'; break;
    case 'Tugas Luar': pesanSukses += ' Selamat melaksanakan tugas di luar sekolah!'; break;
    default: pesanSukses += ' Data Anda telah terekam di sistem.';
  }
  if (ikutTawasul) pesanSukses += ' Kehadiran Briefing & Tawasul juga otomatis tercatat.';
  return { success: true, message: pesanSukses };
}

async function getAbsenMasukUntukEdit(args, env) {
  const [token, tanggal, filterNuptk, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user)) return [];
  const sekolahId = resolveSekolahId(user, requestedSekolahId);

  const dateStr = tanggal || nowJakarta().dateStr;
  const rows = await sbSelect(env, 'absen_masuk', `sekolah_id=eq.${sekolahId}&tanggal=eq.${dateStr}`);
  const filterTarget = String(filterNuptk || 'ALL').trim();

  return rows
    .filter((r) => filterTarget === 'ALL' || String(r.nuptk).trim() === filterTarget)
    .sort((a, b) => String(a.jam).localeCompare(String(b.jam)))
    .map((r) => ({ docId: r.id, nuptk: r.nuptk, nama: r.nama, tanggal: r.tanggal, jam: r.jam, status: r.status, keterangan: r.keterangan }));
}

async function updateAbsenMasuk(args, env) {
  const [token, docId, jamBaru, statusBaru, keteranganBaru] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user)) return { success: false, message: 'Akses ditolak. Hanya Admin yang bisa mengubah data absen.' };
  if (!docId) return { success: false, message: 'Data absen tidak ditemukan (docId kosong).' };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(jamBaru).trim())) {
    return { success: false, message: 'Format jam tidak valid. Gunakan format HH:mm, contoh 07:15.' };
  }
  if (!STATUS_ABSEN_VALID.includes(statusBaru)) return { success: false, message: 'Status tidak dikenal: ' + statusBaru };

  const rows = await sbSelect(env, 'absen_masuk', `id=eq.${encodeURIComponent(docId)}&limit=1`);
  const existing = rows[0];
  if (!existing) return { success: false, message: 'Data absen tidak ditemukan di database (mungkin sudah dihapus).' };
  // Admin Sekolah cuma boleh ubah data sekolahnya sendiri (Admin Utama bebas).
  if (user.role === 'ADMIN_SEKOLAH' && existing.sekolah_id !== user.sekolahId) {
    return { success: false, message: 'Akses ditolak. Data ini bukan milik sekolah Anda.' };
  }

  await sbUpdate(env, 'absen_masuk', 'id', docId, {
    jam: String(jamBaru).trim(), status: statusBaru, keterangan: keteranganBaru || '-'
  });
  await invalidate(env, `ABSEN_MASUK_PERIODE_CACHE_${existing.sekolah_id}`);
  return { success: true, message: `Data absen ${existing.nama} tanggal ${existing.tanggal} berhasil diperbarui.` };
}

// ====================================================================
// KEGIATAN (8 jenis identik + kegiatan khusus)
// ====================================================================

async function checkSudahAbsenKegiatan(args, env) {
  const [token, sheetName, tanggal] = args;
  const user = await requireUser(env, token);
  if (!user) return { sudah: false };
  const config = REPORT_CONFIG[sheetName];
  if (!config) return { sudah: false };

  const dateStr = tanggal || nowJakarta().dateStr;
  let query = `sekolah_id=eq.${user.sekolahId}&nuptk=eq.${encodeURIComponent(user.nuptk)}&${config.dateField}=eq.${dateStr}`;
  if (config.jenisKegiatan) query += `&jenis_kegiatan=eq.${config.jenisKegiatan}`;
  const rows = await sbSelect(env, config.table, query);
  if (rows.length === 0) return { sudah: false };

  const row = rows[0];
  const statusField = config.fields.includes('status_kehadiran') ? 'status_kehadiran' : 'status';
  const waktu = row.timestamp ? new Date(row.timestamp).toISOString().slice(11, 16) : (row.waktu_lapor || '');
  return { sudah: true, status: row[statusField], waktu };
}

async function saveKegiatan(args, env) {
  const [token, sheetName, kegiatan, status, catatan, tanggal, lat, lon] = args;
  const user = await requireUser(env, token);
  if (!user) return { success: false, message: 'Unauthenticated' };
  const sekolahId = user.sekolahId;

  if (status === 'Hadir di Majelis') {
    const settings = await getSettingsMap(env, sekolahId);
    if (lat && lon && settings.lat_pesantren && settings.long_pesantren) {
      const jarak = hitungRadiusGPS(parseFloat(lat), parseFloat(lon), parseFloat(settings.lat_pesantren), parseFloat(settings.long_pesantren));
      const batas = parseInt(settings.radius_pesantren || 100, 10);
      if (jarak > batas) {
        return { success: false, message: `Ditolak! Anda berada di luar area Mesjid Al-Fattah (${jarak} meter dari titik majelis).` };
      }
    } else {
      return { success: false, message: 'Gagal memverifikasi lokasi. Koordinat pesantren belum diatur oleh Admin.' };
    }
  }

  const dateStr = tanggal || nowJakarta().dateStr;
  await sbInsert(env, 'kegiatan_umum', {
    id: generateShortID('K'), sekolah_id: sekolahId, jenis_kegiatan: sheetName, tanggal: dateStr, nuptk: user.nuptk, nama: user.nama,
    kegiatan, status, catatan: catatan || '-', timestamp: new Date().toISOString()
  });
  return { success: true, message: 'Data kehadiran majelis berhasil disimpan.' };
}

async function saveAbsenKegiatanKhusus(args, env) {
  const [token, namaKegiatanStr, statusKehadiran, catatan, lat, lon] = args;
  const user = await requireUser(env, token);
  if (!user) return { success: false, message: 'Sesi habis, silakan login ulang.' };
  const sekolahId = user.sekolahId;

  const { dateStr, timeStr: jamLaporStr } = nowJakarta();
  const inputCleanKegNama = String(namaKegiatanStr).trim().toLowerCase();

  const existing = await sbSelect(env, 'absen_kegiatan_khusus', `sekolah_id=eq.${sekolahId}&nuptk=eq.${encodeURIComponent(user.nuptk)}&tanggal_lapor=eq.${dateStr}`);
  const sudah = existing.some((r) => String(r.nama_kegiatan).trim().toLowerCase() === inputCleanKegNama);
  if (sudah) {
    return { success: false, message: `Ditolak! Anda sudah melakukan presensi untuk kegiatan "${namaKegiatanStr}" hari ini.` };
  }

  let finalStatus = statusKehadiran;
  let waktuKegiatanStr = '', toleransiMenit = 15, latKegiatan = '', lonKegiatan = '', radiusKegiatan = 50;

  const dataJadwal = await getJadwalKegiatanCached(env, sekolahId);
  for (const k of dataJadwal) {
    const dbNama = String(k.nama).trim().toLowerCase();
    if (inputCleanKegNama.includes(dbNama) || dbNama.includes(inputCleanKegNama)) {
      waktuKegiatanStr = k.waktu;
      toleransiMenit = k.toleransi ? parseInt(k.toleransi, 10) : 15;
      latKegiatan = k.lat || ''; lonKegiatan = k.lon || '';
      radiusKegiatan = k.radius ? parseInt(k.radius, 10) : 50;
      break;
    }
  }

  if (statusKehadiran === 'Hadir' && latKegiatan !== '' && lonKegiatan !== '') {
    if (!lat || !lon) {
      return { success: false, message: 'Lokasi GPS Anda tidak terdeteksi. Aktifkan GPS/lokasi di perangkat Anda dan coba lagi.' };
    }
    const jarakMeter = hitungRadiusGPS(parseFloat(lat), parseFloat(lon), parseFloat(latKegiatan), parseFloat(lonKegiatan));
    if (jarakMeter > radiusKegiatan) {
      return { success: false, message: `Ditolak! Anda berada sekitar ${Math.round(jarakMeter)} meter dari lokasi kegiatan (maksimal ${radiusKegiatan} meter). Pastikan Anda sudah berada di lokasi acara sebelum presensi.` };
    }
  }

  if (waktuKegiatanStr) {
    const [mh, mm] = waktuKegiatanStr.split(':').map(Number);
    const [lh, lm] = jamLaporStr.split(':').map(Number);
    const menitBatas = mh * 60 + mm + toleransiMenit;
    const menitLapor = lh * 60 + lm;
    if (statusKehadiran === 'Hadir' && menitLapor > menitBatas) finalStatus = 'Terlambat';
  }

  const jarakTercatat = (lat && lon && latKegiatan !== '' && lonKegiatan !== '')
    ? String(Math.round(hitungRadiusGPS(parseFloat(lat), parseFloat(lon), parseFloat(latKegiatan), parseFloat(lonKegiatan))))
    : '-';

  await sbInsert(env, 'absen_kegiatan_khusus', {
    id: generateShortID('AK'), sekolah_id: sekolahId, tanggal_lapor: dateStr, waktu_lapor: jamLaporStr, nuptk: user.nuptk,
    nama: user.nama, nama_kegiatan: namaKegiatanStr, status_kehadiran: finalStatus,
    catatan: catatan || '', latitude: lat || '-', longitude: lon || '-', jarak: jarakTercatat
  });

  return { success: true, message: `Absensi disimpan pada pukul ${jamLaporStr} WIB.` };
}

async function tutupAbsenKegiatan(args, env) {
  const [token, kegiatanId] = args;
  const user = await requireUser(env, token);
  if (!isRole(user, 'ADMIN_SEKOLAH', 'ADMIN_UTAMA', 'KEPALA_SEKOLAH')) return { success: false, message: 'Akses ditolak.' };

  const rows = await sbSelect(env, 'jadwal_kegiatan', `id=eq.${encodeURIComponent(kegiatanId)}&limit=1`);
  const keg = rows[0];
  if (!keg) return { success: false, message: 'Kegiatan tidak ditemukan (mungkin sudah dihapus).' };
  if (user.role !== 'ADMIN_UTAMA' && keg.sekolah_id !== user.sekolahId) {
    return { success: false, message: 'Akses ditolak. Kegiatan ini bukan milik sekolah Anda.' };
  }
  const sekolahId = keg.sekolah_id;

  const jamSekarangStr = nowJakarta().timeStr;
  const tanggalKeg = keg.tanggal;
  const cleanKegNama = String(keg.nama).trim().toLowerCase().split('(')[0].trim();

  const absenKegIni = await sbSelect(env, 'absen_kegiatan_khusus', `sekolah_id=eq.${sekolahId}&tanggal_lapor=eq.${tanggalKeg}`);
  const sudahAbsen = absenKegIni
    .filter((r) => {
      const rowKeg = String(r.nama_kegiatan).trim().toLowerCase().split('(')[0].trim();
      return rowKeg === cleanKegNama || rowKeg.includes(cleanKegNama);
    })
    .map((r) => String(r.nuptk).trim());

  const users = await getUsersListCached(env, sekolahId);
  const kegTipePeserta = keg.tipe_peserta || 'Semua GTK';
  const kegDaftarPeserta = keg.daftar_peserta || [];
  let jumlahDitandai = 0;

  for (const u of users) {
    const userNuptk = String(u.nuptk).trim();
    const userRole = String(u.role).trim();
    const userStatus = String(u.status).trim();
    if (['GURU', 'KEPALA_SEKOLAH', 'PIKET', 'ADMIN_SEKOLAH'].includes(userRole) && userStatus === 'Aktif') {
      const diundang = kegTipePeserta !== 'Terbatas' || kegDaftarPeserta.includes(userNuptk);
      if (diundang && !sudahAbsen.includes(userNuptk)) {
        await sbInsert(env, 'absen_kegiatan_khusus', {
          id: generateShortID('AK'), sekolah_id: sekolahId, tanggal_lapor: tanggalKeg, waktu_lapor: jamSekarangStr, nuptk: userNuptk,
          nama: u.nama, nama_kegiatan: keg.nama, status_kehadiran: 'Tanpa Keterangan',
          catatan: 'Tidak Absen (Absen Ditutup Admin)', latitude: '-', longitude: '-', jarak: '-'
        });
        jumlahDitandai++;
      }
    }
  }

  await sbUpdate(env, 'jadwal_kegiatan', 'id', kegiatanId, { status: 'Nonaktif' });
  await invalidate(env, `JADWAL_KEGIATAN_CACHE_${sekolahId}`);

  return { success: true, message: `Absen "${keg.nama}" ditutup. ${jumlahDitandai} peserta yang belum absen ditandai Tanpa Keterangan.` };
}

// ====================================================================
// JADWAL KEGIATAN (agenda/rapat)
// ====================================================================

async function saveJadwalKegiatan(args, env) {
  const [token, namaKegiatan, tanggal, waktu, toleransi, tipePeserta, daftarNuptkPeserta, lat, lon, radiusMeter, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user)) return { success: false, message: 'Akses ditolak.' };
  const sekolahId = resolveSekolahId(user, requestedSekolahId);

  const id = generateShortID('JK');
  const tipe = tipePeserta === 'Terbatas' ? 'Terbatas' : 'Semua GTK';
  const daftarArr = tipe === 'Terbatas' && Array.isArray(daftarNuptkPeserta) ? daftarNuptkPeserta : [];
  if (tipe === 'Terbatas' && daftarArr.length === 0) {
    return { success: false, message: 'Pilih minimal 1 peserta untuk rapat terbatas.' };
  }

  await sbInsert(env, 'jadwal_kegiatan', {
    id, sekolah_id: sekolahId, nama: namaKegiatan, tanggal, waktu, status: 'Aktif',
    toleransi: toleransi ? parseInt(toleransi, 10) : 15, tipe_peserta: tipe,
    daftar_peserta: daftarArr,
    lat: lat !== undefined && lat !== null && lat !== '' ? parseFloat(lat) : null,
    lon: lon !== undefined && lon !== null && lon !== '' ? parseFloat(lon) : null,
    radius: radiusMeter ? parseInt(radiusMeter, 10) : 50
  });
  await invalidate(env, `JADWAL_KEGIATAN_CACHE_${sekolahId}`);
  return { success: true, message: 'Jadwal kegiatan berhasil ditambahkan!' };
}

async function getJadwalKegiatan(args, env) {
  const [token, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!user) return [];
  const sekolahId = resolveSekolahId(user, requestedSekolahId);
  const result = await getJadwalKegiatanCached(env, sekolahId);

  result.sort((a, b) => {
    if (a.tanggal !== b.tanggal) return a.tanggal < b.tanggal ? 1 : -1;
    return (a.waktu || '') < (b.waktu || '') ? 1 : -1;
  });

  return result.map((k) => ({
    id: k.id, nama: k.nama, tanggal: k.tanggal, waktu: k.waktu,
    status: k.status || 'Aktif', toleransi: k.toleransi || 15,
    tipePeserta: k.tipe_peserta || 'Semua GTK', daftarPeserta: k.daftar_peserta || [],
    lat: k.lat || '', lon: k.lon || '', radius: k.radius || 50, row: k.id
  }));
}

async function toggleStatusKegiatan(args, env) {
  const [token, idAtauRow, statusSekarang] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user)) return { success: false, message: 'Akses ditolak.' };

  const rows = await sbSelect(env, 'jadwal_kegiatan', `id=eq.${encodeURIComponent(String(idAtauRow).trim())}&limit=1`);
  const keg = rows[0];
  if (!keg) return { success: false, message: 'Kegiatan tidak ditemukan.' };
  if (user.role !== 'ADMIN_UTAMA' && keg.sekolah_id !== user.sekolahId) {
    return { success: false, message: 'Akses ditolak. Kegiatan ini bukan milik sekolah Anda.' };
  }

  const statusBaru = statusSekarang === 'Aktif' ? 'Nonaktif' : 'Aktif';
  await sbUpdate(env, 'jadwal_kegiatan', 'id', String(idAtauRow).trim(), { status: statusBaru });
  await invalidate(env, `JADWAL_KEGIATAN_CACHE_${keg.sekolah_id}`);
  return { success: true, message: `Status kegiatan berhasil diubah menjadi [${statusBaru}].` };
}

async function deleteJadwalKegiatan(args, env) {
  const [token, idAtauRow] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user)) return { success: false, message: 'Akses ditolak.' };

  const rows = await sbSelect(env, 'jadwal_kegiatan', `id=eq.${encodeURIComponent(String(idAtauRow).trim())}&limit=1`);
  const keg = rows[0];
  if (!keg) return { success: false, message: 'Kegiatan tidak ditemukan.' };
  if (user.role !== 'ADMIN_UTAMA' && keg.sekolah_id !== user.sekolahId) {
    return { success: false, message: 'Akses ditolak. Kegiatan ini bukan milik sekolah Anda.' };
  }

  await sbDelete(env, 'jadwal_kegiatan', 'id', String(idAtauRow).trim());
  await invalidate(env, `JADWAL_KEGIATAN_CACHE_${keg.sekolah_id}`);
  return { success: true, message: 'Jadwal kegiatan berhasil dihapus.' };
}

// ====================================================================
// DASHBOARD
// ====================================================================

async function getDashboardData(args, env) {
  const [token, startDate, endDate, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!user) return null;
  const sekolahId = resolveSekolahId(user, requestedSekolahId);

  const { dateStr, dayOfWeek } = nowJakarta();
  const mingguIni = getMingguIniSeninJumat();

  let data = {
    todayStatus: 'Belum Absen', hadir: 0, terlambat: 0, izin: 0, sakit: 0, tugas_luar: 0, alpa_guru: 0,
    totalGuru: 0, adHadir: 0, adTerlambat: 0, adIzin: 0, adSakit: 0, adTugasLuar: 0, adBelum: 0,
    listBelumAbsen: [], periodeLabel: mingguIni.label,
    periodeKeterangan: 'Rekap ringkas minggu berjalan (Senin-Jumat). Untuk rekap penggajian bulanan penuh, buka menu Laporan/Payroll atau pakai filter tanggal manual.',
    listHadir: [], listTerlambat: [], listSakit: [], listIzin: [], listTugasLuar: [], listAlpa: []
  };

  let apakahHariLibur = false;
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    data.todayStatus = 'Libur Akhir Pekan'; apakahHariLibur = true;
  } else {
    const statusLibur = await checkApakahHariLibur(env, sekolahId, dateStr);
    if (statusLibur) { data.todayStatus = 'Libur: ' + statusLibur; apakahHariLibur = true; }
  }

  const users = await getUsersListCached(env, sekolahId);
  data.totalGuru = users.filter((u) => ['GURU', 'KEPALA_SEKOLAH', 'PIKET', 'ADMIN_SEKOLAH'].includes(String(u.role).trim()) && String(u.status).trim() === 'Aktif').length;

  let sDate, eDate;
  if (startDate && endDate) {
    sDate = new Date(startDate); eDate = new Date(endDate);
  } else {
    sDate = mingguIni.start; eDate = mingguIni.end;
  }
  const sDateStr = toDateStr(sDate);
  const eDateStr = toDateStr(eDate);

  const sheetMasuk = await sbSelect(env, 'absen_masuk', `sekolah_id=eq.${sekolahId}&tanggal=gte.${sDateStr}&tanggal=lte.${eDateStr}`);

  let sudahAbsenHariIni = [];
  let statusGuruHariIni = {};

  sheetMasuk.forEach((row) => {
    const rowDateStr = row.tanggal;
    const statusAbsen = String(row.status).trim();
    const namaGuru = String(row.nama).trim();
    const nuptkGuru = String(row.nuptk).trim();

    if (isAdminAny(user) || isRole(user, 'PIKET', 'KEPALA_SEKOLAH')) {
      const rowDateObj = new Date(rowDateStr);
      const sDateAdmin = startDate ? new Date(startDate) : new Date(dateStr);
      const eDateAdmin = endDate ? new Date(endDate) : new Date(dateStr);
      if (rowDateObj >= sDateAdmin && rowDateObj <= eDateAdmin) {
        if (statusAbsen === 'Hadir') data.adHadir++;
        else if (statusAbsen === 'Terlambat') data.adTerlambat++;
        else if (statusAbsen === 'Izin') data.adIzin++;
        else if (statusAbsen === 'Sakit') data.adSakit++;
        else if (statusAbsen === 'Tugas Luar') data.adTugasLuar++;
        else if (statusAbsen === 'Tanpa Keterangan') data.adBelum++;
      }
    }

    if (nuptkGuru === String(user.nuptk).trim()) {
      if (rowDateStr === dateStr) data.todayStatus = statusAbsen;
      const sDateGuru = startDate && endDate ? new Date(startDate) : mingguIni.start;
      const eDateGuru = startDate && endDate ? new Date(endDate) : mingguIni.end;
      const rowDateObjGuru = new Date(rowDateStr);
      if (rowDateObjGuru >= sDateGuru && rowDateObjGuru <= eDateGuru) {
        if (statusAbsen === 'Hadir') data.hadir++;
        else if (statusAbsen === 'Terlambat') data.terlambat++;
        else if (statusAbsen === 'Izin') data.izin++;
        else if (statusAbsen === 'Sakit') data.sakit++;
        else if (statusAbsen === 'Tugas Luar') data.tugas_luar++;
        else if (statusAbsen === 'Tanpa Keterangan') data.alpa_guru++;
      }
    }

    if (rowDateStr === dateStr) {
      sudahAbsenHariIni.push(nuptkGuru);
      statusGuruHariIni[nuptkGuru] = { nama: namaGuru, status: statusAbsen };
    }
  });

  users.forEach((u) => {
    const uNuptk = String(u.nuptk).trim(), uNama = String(u.nama).trim();
    const uRole = String(u.role).trim(), uStatus = String(u.status).trim();
    if (['GURU', 'KEPALA_SEKOLAH', 'PIKET', 'ADMIN_SEKOLAH'].includes(uRole) && uStatus === 'Aktif') {
      if (!sudahAbsenHariIni.includes(uNuptk)) {
        if (!apakahHariLibur) { data.listBelumAbsen.push({ nuptk: uNuptk, nama: uNama }); data.listAlpa.push(uNama); }
      } else {
        const info = statusGuruHariIni[uNuptk];
        if (info) {
          if (info.status === 'Hadir') data.listHadir.push(uNama);
          else if (info.status === 'Terlambat') data.listTerlambat.push(uNama);
          else if (info.status === 'Sakit') data.listSakit.push(uNama);
          else if (info.status === 'Izin') data.listIzin.push(uNama);
          else if (info.status === 'Tugas Luar') data.listTugasLuar.push(uNama);
          else if (info.status === 'Tanpa Keterangan') data.listAlpa.push(uNama);
        }
      }
    }
  });

  return data;
}

// ====================================================================
// SETTINGS
// ====================================================================

async function getSettingsData(args, env) {
  const [token, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user) && !isRole(user, 'PIKET')) return {};
  const sekolahId = resolveSekolahId(user, requestedSekolahId);
  return getSettingsMap(env, sekolahId);
}

async function saveSettingsData(args, env) {
  const [token, config, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user)) return false;
  const sekolahId = resolveSekolahId(user, requestedSekolahId);

  for (const key of Object.keys(config)) {
    if (config[key] !== undefined) {
      const existingRows = await sbSelect(env, 'settings', `sekolah_id=eq.${sekolahId}&key=eq.${encodeURIComponent(key)}&limit=1`);
      if (existingRows.length > 0) {
        // Primary key settings sekarang gabungan (sekolah_id, key) - HARUS filter
        // 2 kolom sekaligus, kalau cuma filter "key" saja bisa salah update ke sekolah lain.
        await sbUpdateWhere(env, 'settings', { sekolah_id: sekolahId, key }, { value: String(config[key]) });
      } else {
        await sbInsert(env, 'settings', { sekolah_id: sekolahId, key, value: String(config[key]) });
      }
    }
  }
  await invalidate(env, `SETTINGS_CACHE_${sekolahId}`);
  return true;
}

// ====================================================================
// USERS / GURU
// ====================================================================

async function getUsers(args, env) {
  const [token, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user)) return [];
  const sekolahId = resolveSekolahId(user, requestedSekolahId);
  const result = await getUsersListCached(env, sekolahId);
  return result.map((u) => ({ id: u.legacy_id, nuptk: u.nuptk, nama: u.nama, email: u.email, role: u.role, status: u.status, kategori: u.kategori || 'Mengajar' }));
}

async function saveUser(args, env) {
  const [token, userData] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user)) return false;

  // Cuma Admin Utama yang boleh bikin akun ADMIN_SEKOLAH baru.
  if (userData.role === 'ADMIN_SEKOLAH' && user.role !== 'ADMIN_UTAMA') return false;
  if (userData.role === 'ADMIN_UTAMA') return false; // tidak ada UI untuk ini, sengaja diblokir dari sisi backend juga

  // Admin Sekolah: user baru otomatis masuk sekolahnya sendiri.
  // Admin Utama: WAJIB sertakan userData.sekolahId (pilih dari dropdown sekolah di form).
  let sekolahId;
  if (user.role === 'ADMIN_UTAMA') {
    if (!userData.sekolahId) return false;
    sekolahId = userData.sekolahId;
  } else {
    sekolahId = user.sekolahId;
  }

  const nuptk = String(userData.nuptk).trim();
  await sbInsert(env, 'users', {
    nuptk, sekolah_id: sekolahId, legacy_id: generateShortID('U'), nama: userData.nama, email: userData.email,
    password: userData.password, role: userData.role, status: 'Aktif',
    created_at: new Date().toISOString(), kategori: userData.kategori || 'Mengajar'
  });
  await invalidate(env, `USERS_CACHE_${sekolahId}`);
  return true;
}

async function updateUser(args, env) {
  const [token, nuptkTarget, userData] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user)) return { success: false, message: 'Akses ditolak.' };

  const rows = await sbSelect(env, 'users', `nuptk=eq.${encodeURIComponent(String(nuptkTarget).trim())}&limit=1`);
  const target = rows[0];
  if (!target) return { success: false, message: 'Pendidik tidak ditemukan.' };
  if (user.role !== 'ADMIN_UTAMA' && target.sekolah_id !== user.sekolahId) {
    return { success: false, message: 'Akses ditolak. Pendidik ini bukan dari sekolah Anda.' };
  }
  // Admin Sekolah tidak boleh naikkan siapa pun jadi ADMIN_SEKOLAH/ADMIN_UTAMA lewat edit.
  if (['ADMIN_SEKOLAH', 'ADMIN_UTAMA'].includes(userData.role) && user.role !== 'ADMIN_UTAMA') {
    return { success: false, message: 'Akses ditolak. Hanya Admin Utama yang bisa mengatur role Admin.' };
  }

  const dataUpdate = {
    nama: userData.nama, email: userData.email, role: userData.role,
    status: userData.status, kategori: userData.kategori || 'Mengajar'
  };
  // Password cuma diupdate kalau memang diisi ulang (kolom dikosongkan di form = tidak diubah).
  if (userData.password && String(userData.password).trim() !== '') {
    dataUpdate.password = String(userData.password).trim();
  }

  await sbUpdate(env, 'users', 'nuptk', String(nuptkTarget).trim(), dataUpdate);
  await invalidate(env, `USERS_CACHE_${target.sekolah_id}`);
  return { success: true, message: `Data ${target.nama} berhasil diperbarui.` };
}

async function getGuruList(args, env) {
  const [token, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user) && !isRole(user, 'PIKET', 'KEPALA_SEKOLAH')) return [];
  const sekolahId = resolveSekolahId(user, requestedSekolahId);
  const result = await getUsersListCached(env, sekolahId);
  return result.filter((u) => !['ADMIN_SEKOLAH', 'ADMIN_UTAMA'].includes(String(u.role).trim()))
    .map((u) => ({ id: u.legacy_id, nuptk: u.nuptk, nama: u.nama, status: u.status, role: u.role, row: u.nuptk }));
}

async function getGuruMengajarList(args, env) {
  const [token, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user) && !isRole(user, 'PIKET', 'KEPALA_SEKOLAH')) return [];
  const sekolahId = resolveSekolahId(user, requestedSekolahId);
  const result = await getUsersListCached(env, sekolahId);
  return result.filter((u) => (u.kategori || 'Mengajar') === 'Mengajar' && !['ADMIN_SEKOLAH', 'ADMIN_UTAMA'].includes(String(u.role).trim()))
    .map((u) => ({ id: u.legacy_id, nuptk: u.nuptk, nama: u.nama, status: u.status, role: u.role, row: u.nuptk }));
}

async function deleteUser(args, env) {
  const [token, nuptkAtauRow] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user)) return { success: false, message: 'Akses ditolak. Anda bukan Admin.' };

  const rows = await sbSelect(env, 'users', `nuptk=eq.${encodeURIComponent(String(nuptkAtauRow).trim())}&limit=1`);
  const target = rows[0];
  if (!target) return { success: false, message: 'Pendidik tidak ditemukan.' };
  if (user.role !== 'ADMIN_UTAMA' && target.sekolah_id !== user.sekolahId) {
    return { success: false, message: 'Akses ditolak. Pendidik ini bukan dari sekolah Anda.' };
  }
  if (['ADMIN_SEKOLAH', 'ADMIN_UTAMA'].includes(target.role) && user.role !== 'ADMIN_UTAMA') {
    return { success: false, message: 'Akses ditolak. Hanya Admin Utama yang bisa menghapus akun Admin.' };
  }

  await sbDelete(env, 'users', 'nuptk', String(nuptkAtauRow).trim());
  await invalidate(env, `USERS_CACHE_${target.sekolah_id}`);
  return { success: true, message: 'Data pendidik berhasil dihapus dari sistem.' };
}

async function getStafAktifUntukImpal(args, env) {
  const [token, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user) && !isRole(user, 'PIKET', 'KEPALA_SEKOLAH')) return [];
  const sekolahId = resolveSekolahId(user, requestedSekolahId);
  const users = await getUsersListCached(env, sekolahId);
  return users.filter((u) => String(u.status).trim() === 'Aktif' && !['ADMIN_SEKOLAH', 'ADMIN_UTAMA'].includes(String(u.role).trim()))
    .map((u) => ({ nuptk: u.nuptk, nama: u.nama, role: u.role, kategori: u.kategori || 'Mengajar' }));
}

// ====================================================================
// LIBUR NASIONAL
// ====================================================================

async function saveHariLibur(args, env) {
  const [token, tglMulai, tglSelesai, keterangan, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user)) return { success: false, message: 'Akses ditolak.' };
  const sekolahId = resolveSekolahId(user, requestedSekolahId);
  if (new Date(tglMulai) > new Date(tglSelesai)) {
    return { success: false, message: 'Tanggal mulai tidak boleh melebihi tanggal selesai libur!' };
  }
  const id = generateShortID('L');
  await sbInsert(env, 'libur_nasional', { id, sekolah_id: sekolahId, tgl_mulai: tglMulai, tgl_selesai: tglSelesai, keterangan });
  await invalidate(env, `LIBUR_CACHE_${sekolahId}`);
  return { success: true, message: 'Rentang hari libur sekolah berhasil dijadwalkan!' };
}

async function getLiburList(args, env) {
  const [token, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user) && !isRole(user, 'PIKET')) return [];
  const sekolahId = resolveSekolahId(user, requestedSekolahId);
  const result = await getLiburListCached(env, sekolahId);
  return result.map((l) => ({ id: l.id, tglMulai: l.tgl_mulai, tglSelesai: l.tgl_selesai, keterangan: l.keterangan, row: l.id }));
}

async function deleteHariLibur(args, env) {
  const [token, idAtauRow] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user)) return { success: false, message: 'Akses ditolak.' };

  const rows = await sbSelect(env, 'libur_nasional', `id=eq.${encodeURIComponent(String(idAtauRow).trim())}&limit=1`);
  const target = rows[0];
  if (!target) return { success: false, message: 'Data libur tidak ditemukan.' };
  if (user.role !== 'ADMIN_UTAMA' && target.sekolah_id !== user.sekolahId) {
    return { success: false, message: 'Akses ditolak. Data ini bukan milik sekolah Anda.' };
  }

  await sbDelete(env, 'libur_nasional', 'id', String(idAtauRow).trim());
  await invalidate(env, `LIBUR_CACHE_${target.sekolah_id}`);
  return { success: true, message: 'Hari libur berhasil dihapus.' };
}

// ====================================================================
// LAPORAN / PAYROLL
// ====================================================================

async function getPayrollReport(args, env) {
  const [token, startDate, endDate, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user) && !isRole(user, 'PIKET', 'KEPALA_SEKOLAH')) return [];
  const sekolahId = resolveSekolahId(user, requestedSekolahId);

  const sDateStr = toDateStr(new Date(startDate));
  const eDateStr = toDateStr(new Date(endDate));

  const users = await getUsersListCached(env, sekolahId);
  const payrollMap = {};
  users.forEach((u) => {
    if (['GURU', 'KEPALA_SEKOLAH', 'PIKET', 'ADMIN_SEKOLAH'].includes(String(u.role).trim()) && String(u.status).trim() === 'Aktif') {
      payrollMap[u.nuptk] = { nuptk: u.nuptk, nama: u.nama, hadir: 0, terlambat: 0, sakit: 0, izin: 0, tugasLuar: 0, alpa: 0 };
    }
  });

  const rows = await sbSelect(env, 'absen_masuk', `sekolah_id=eq.${sekolahId}&tanggal=gte.${sDateStr}&tanggal=lte.${eDateStr}`);
  rows.forEach((row) => {
    const nuptk = String(row.nuptk).trim(), status = String(row.status).trim();
    if (payrollMap[nuptk]) {
      if (status === 'Hadir') payrollMap[nuptk].hadir++;
      else if (status === 'Terlambat') payrollMap[nuptk].terlambat++;
      else if (status === 'Sakit') payrollMap[nuptk].sakit++;
      else if (status === 'Izin') payrollMap[nuptk].izin++;
      else if (status === 'Tugas Luar') payrollMap[nuptk].tugasLuar++;
      else if (status === 'Tanpa Keterangan') payrollMap[nuptk].alpa++;
    }
  });
  return Object.values(payrollMap);
}

async function getReport(args, env) {
  const [token, startDate, endDate, type, filterNuptk, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user) && !isRole(user, 'PIKET', 'KEPALA_SEKOLAH')) return [];
  const sekolahId = resolveSekolahId(user, requestedSekolahId);

  const config = REPORT_CONFIG[type];
  if (!config) return { headers: [], data: [] };

  const sDateStr = toDateStr(new Date(startDate));
  const eDateStr = toDateStr(new Date(endDate));

  let query = `sekolah_id=eq.${sekolahId}&${config.dateField}=gte.${sDateStr}&${config.dateField}=lte.${eDateStr}`;
  if (config.jenisKegiatan) query += `&jenis_kegiatan=eq.${config.jenisKegiatan}`;
  const rows = await sbSelect(env, config.table, query);

  const filterTarget = String(filterNuptk).trim();

  rows.sort((a, b) => {
    if (a[config.dateField] !== b[config.dateField]) return a[config.dateField] < b[config.dateField] ? -1 : 1;
    const valA = a[config.sortField], valB = b[config.sortField];
    if (valA === valB) return 0;
    return valA < valB ? -1 : 1;
  });

  const result = [];
  rows.forEach((row) => {
    if (filterTarget !== 'ALL' && String(row.nuptk).trim() !== filterTarget) return;
    const rowObj = {};
    config.headers.forEach((header, j) => {
      let val = row[config.fields[j]];
      rowObj[header] = val === undefined || val === null ? '' : val;
    });
    result.push(rowObj);
  });

  return { headers: config.headers, data: result };
}

async function getRekapJamPelajaranSendiri(args, env) {
  const [token, startDate, endDate] = args;
  const user = await requireUser(env, token);
  if (!user) return null;
  const sekolahId = user.sekolahId;

  const periodeBerjalan = getPeriodeBerjalan();
  let sDate, eDate, periodeLabel;
  if (startDate && endDate) {
    sDate = new Date(startDate); eDate = new Date(endDate);
    periodeLabel = `${sDate.getDate()}/${sDate.getMonth() + 1}/${sDate.getFullYear()} - ${eDate.getDate()}/${eDate.getMonth() + 1}/${eDate.getFullYear()}`;
  } else {
    sDate = periodeBerjalan.start; eDate = periodeBerjalan.end; periodeLabel = periodeBerjalan.label;
  }

  const rows = await sbSelect(env, 'rekap_jam_pelajaran', `sekolah_id=eq.${sekolahId}&tanggal=gte.${toDateStr(sDate)}&tanggal=lte.${toDateStr(eDate)}`);
  const counter = { Impal: 0, Terlambat: 0, Dinas: 0, Sakit: 0, Izin: 0, Alpa: 0 };

  rows.forEach((row) => {
    if (row.nuptk === user.nuptk) {
      if (row.status === 'Terlambat') counter.Terlambat++;
      else if (row.status === 'Tugas Luar') counter.Dinas++;
      else if (row.status === 'Sakit') counter.Sakit++;
      else if (row.status === 'Izin') counter.Izin++;
      else if (row.status === 'Tanpa Keterangan') counter.Alpa++;
    }
    if (row.nuptk_impal && row.nuptk_impal !== '-') {
      if (row.nuptk_impal === user.nuptk) counter.Impal++;
    } else if (row.guru_impal === user.nama) {
      counter.Impal++;
    }
  });

  return { counter, periodeLabel };
}

async function getPayrollJamPelajaran(args, env) {
  const [token, startDate, endDate, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user) && !isRole(user, 'PIKET', 'KEPALA_SEKOLAH')) return [];
  const sekolahId = resolveSekolahId(user, requestedSekolahId);

  const rows = await sbSelect(env, 'rekap_jam_pelajaran', `sekolah_id=eq.${sekolahId}&tanggal=gte.${toDateStr(new Date(startDate))}&tanggal=lte.${toDateStr(new Date(endDate))}`);
  const users = await getUsersListCached(env, sekolahId);
  const rekapMap = {};
  users.forEach((u) => {
    if (['GURU', 'KEPALA_SEKOLAH', 'PIKET', 'ADMIN_SEKOLAH'].includes(String(u.role).trim()) && String(u.status).trim() === 'Aktif') {
      rekapMap[u.nuptk] = { nuptk: u.nuptk, nama: u.nama, impal: 0, terlambat: 0, sakit: 0, izin: 0, tugasLuar: 0, alpa: 0 };
    }
  });

  rows.forEach((row) => {
    const nuptk = row.nuptk, status = row.status;
    if (rekapMap[nuptk]) {
      if (status === 'Terlambat') rekapMap[nuptk].terlambat++;
      else if (status === 'Sakit') rekapMap[nuptk].sakit++;
      else if (status === 'Izin') rekapMap[nuptk].izin++;
      else if (status === 'Tugas Luar') rekapMap[nuptk].tugasLuar++;
      else if (status === 'Tanpa Keterangan') rekapMap[nuptk].alpa++;
    }
    if (row.nuptk_impal && row.nuptk_impal !== '-' && rekapMap[row.nuptk_impal]) {
      rekapMap[row.nuptk_impal].impal++;
    } else if (row.guru_impal && row.guru_impal !== '-') {
      for (const key in rekapMap) { if (rekapMap[key].nama === row.guru_impal) { rekapMap[key].impal++; break; } }
    }
  });

  return Object.values(rekapMap);
}

async function saveRekapJamPelajaran(args, env) {
  const [token, tanggal, nuptkGuru, namaGuru, jamKeArray, status, guruImpalNama, guruImpalNuptk] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user) && !isRole(user, 'PIKET')) return { success: false, message: 'Akses ditolak. Fitur ini khusus Piket/Admin.' };
  if (!Array.isArray(jamKeArray) || jamKeArray.length === 0) return { success: false, message: 'Pilih minimal 1 Jam Pelajaran.' };
  const sekolahId = user.sekolahId;

  const timestamp = new Date().toISOString();
  const jamTerurut = jamKeArray.slice().sort((a, b) => Number(a) - Number(b));

  for (const jam of jamTerurut) {
    await sbInsert(env, 'rekap_jam_pelajaran', {
      id: generateShortID('JP'), sekolah_id: sekolahId, tanggal, nuptk: nuptkGuru, nama_guru: namaGuru, jam_ke: 'JP ' + jam,
      status, guru_impal: guruImpalNama || '-', diinput_oleh: user.nama, timestamp, nuptk_impal: guruImpalNuptk || '-'
    });
  }
  return { success: true, message: `${jamTerurut.length} baris rekap jam pelajaran berhasil dicatat (JP ${jamTerurut.join(', ')}).` };
}

// ====================================================================
// FCM / NOTIFIKASI (dipanggil dari frontend & dari cron)
// ====================================================================

async function simpanTokenFCM(args, env) {
  const [token, fcmToken] = args;
  const user = await requireUser(env, token);
  if (!user) return { success: false, message: 'Unauthenticated' };

  const rows = await sbSelect(env, 'users', `nuptk=eq.${encodeURIComponent(user.nuptk)}&limit=1`);
  if (!rows[0]) return { success: false, message: 'User tidak ditemukan di database.' };

  await sbUpdate(env, 'users', 'nuptk', user.nuptk, { fcm_token: fcmToken });
  await invalidate(env, `USERS_CACHE_${user.sekolahId}`);
  return { success: true, message: 'Token berhasil diupdate.' };
}

/** Dipanggil dari Cron Trigger (07:20 WIB). Jalan untuk SEMUA sekolah sekaligus. */
export async function cekDanKirimNotifikasiBelumAbsen(env) {
  const { dateStr, dayOfWeek } = nowJakarta();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    console.log('Akhir pekan, sistem libur.');
    return;
  }

  const daftarSekolah = await sbSelect(env, 'sekolah', "status=eq.Aktif");

  for (const sekolah of daftarSekolah) {
    const sekolahId = sekolah.id;
    const statusLibur = await checkApakahHariLibur(env, sekolahId, dateStr);
    if (statusLibur) {
      console.log(`[${sekolahId}] Hari ini libur: ${statusLibur}. Notifikasi dibatalkan.`);
      continue;
    }

    const users = await getUsersListCached(env, sekolahId);
    const absenHariIni = await sbSelect(env, 'absen_masuk', `sekolah_id=eq.${sekolahId}&tanggal=eq.${dateStr}`);
    const sudahAbsenNuptk = absenHariIni.map((r) => String(r.nuptk).trim());

    let jumlahDikirim = 0;
    for (const u of users) {
      const uRole = String(u.role).trim(), uStatus = String(u.status).trim(), uNuptk = String(u.nuptk).trim();
      const fcmToken = u.fcm_token;
      if (['GURU', 'KEPALA_SEKOLAH', 'PIKET', 'ADMIN_SEKOLAH'].includes(uRole) && uStatus === 'Aktif') {
        if (!sudahAbsenNuptk.includes(uNuptk) && fcmToken) {
          const judul = 'Pengingat Presensi Masuk ⏱️';
          const pesan = `Halo ${u.nama}, waktu sudah menunjukkan pukul 07.20 WIB. Mari segera lakukan presensi masuk sebelum terlambat!`;
          await kirimNotifikasiKeSatuHP(env, fcmToken, judul, pesan);
          jumlahDikirim++;
        }
      }
    }
    console.log(`[${sekolahId}] Selesai! Notifikasi dikirim ke ${jumlahDikirim} GTK yang belum absen.`);
  }
}

/**
 * Dipanggil dari Cron Trigger (12:20 WIB, Senin-Jumat), atau manual lewat tombol Admin Utama
 * (jalankanAutoAlpaManual). Jalan untuk SEMUA sekolah sekaligus.
 *
 * Mengembalikan ringkasan hasil {sekolahDiproses, sekolahDilewati, sekolahError,
 * totalDitandaiAlpa} - dulu fungsi ini tidak mengembalikan apa-apa (void), jadi
 * kalau ada error di satu sekolah, seluruh proses berhenti diam-diam tanpa jejak
 * (cuma keliatan di log Cloudflare, yang sering tidak dicek). Sekarang tiap sekolah
 * dibungkus try/catch sendiri-sendiri (1 sekolah error tidak menghentikan sekolah
 * lain), dan hasilnya bisa langsung dilihat kalau dipanggil manual dari Pengaturan.
 */
export async function autoSetTanpaKeterangan(env) {
  const { dateStr, dayOfWeek } = nowJakarta();
  const ringkasan = { sekolahDiproses: [], sekolahDilewati: [], sekolahError: [], totalDitandaiAlpa: 0 };

  if (dayOfWeek === 0 || dayOfWeek === 6) {
    console.log('[autoSetTanpaKeterangan] Akhir pekan, dilewati untuk semua sekolah.');
    return ringkasan;
  }

  const daftarSekolah = await sbSelect(env, 'sekolah', "status=eq.Aktif");
  console.log(`[autoSetTanpaKeterangan] Ditemukan ${daftarSekolah.length} sekolah berstatus Aktif untuk diproses (tanggal ${dateStr}).`);

  for (const sekolah of daftarSekolah) {
    const sekolahId = sekolah.id;
    try {
      const settings = await getSettingsMap(env, sekolahId);
      if ((settings.status_auto_alpa || 'Aktif') === 'Nonaktif') {
        console.log(`[${sekolahId}] Auto Alpa dinonaktifkan sementara oleh Admin.`);
        ringkasan.sekolahDilewati.push(`${sekolahId} (auto alpa nonaktif)`);
        continue;
      }

      const statusLibur = await checkApakahHariLibur(env, sekolahId, dateStr);
      if (statusLibur) {
        ringkasan.sekolahDilewati.push(`${sekolahId} (libur: ${statusLibur})`);
        continue;
      }

      const users = await getUsersListCached(env, sekolahId);
      const absenHariIni = await sbSelect(env, 'absen_masuk', `sekolah_id=eq.${sekolahId}&tanggal=eq.${dateStr}`);
      const sudahAbsenHariIni = absenHariIni.map((r) => String(r.nuptk).trim());

      // Kumpulkan dulu semua baris yang perlu ditambahkan, baru kirim 1x lewat bulk
      // insert (bukan 1 request HTTP per guru) - supaya tidak menabrak limit
      // "Too many subrequests by single Worker invocation" di Cloudflare kalau
      // jumlah guru banyak. NB: nilai jarak 'xx m' (placeholder lama) diganti '0 m' -
      // format "<angka> m" ini yang valid untuk kolom jarak, sama seperti presensi
      // normal (bukan teks bebas "xx m" yang bikin Supabase menolak dengan error
      // "invalid input syntax for type numeric").
      let jumlahEligible = 0; // masuk kriteria role+status aktif (calon "wajib absen")
      const calonBaris = [];
      for (const u of users) {
        const userRole = String(u.role).trim(), userStatus = String(u.status).trim();
        const userNuptk = String(u.nuptk).trim(), userNama = String(u.nama).trim();

        if (['GURU', 'KEPALA_SEKOLAH', 'PIKET', 'ADMIN_SEKOLAH'].includes(userRole) && userStatus === 'Aktif') {
          jumlahEligible++;
          if (!sudahAbsenHariIni.includes(userNuptk)) {
            calonBaris.push({
              id: generateShortID('AO'), sekolah_id: sekolahId, tanggal: dateStr, nuptk: userNuptk, nama: userNama,
              jam: '--:--', latitude: '-', longitude: '-', jarak: '0 m',
              status: 'Tanpa Keterangan', keterangan: 'Tidak Absen!', maps_link: '-'
            });
          }
        }
      }
      // Rincian debug ini SENGAJA selalu disertakan (bukan cuma pas error) - supaya
      // kalau "Total ditandai" ternyata 0 padahal harusnya tidak, bisa langsung
      // ketahuan di tahap mana penyebabnya tanpa perlu buka log Cloudflare:
      // total user di tabel 'users' utk sekolah ini, berapa yang lolos filter
      // role+status Aktif, dan berapa yang sistem anggap sudah absen hari ini.
      const debugInfo = `total user: ${users.length}, eligible (role+aktif): ${jumlahEligible}, sudah ada baris hari ini: ${sudahAbsenHariIni.length}`;

      let ditandaiDiSekolahIni = 0;
      if (calonBaris.length) {
        try {
          const hasil = await sbInsertMany(env, 'absen_masuk', calonBaris);
          ditandaiDiSekolahIni = hasil.length;
        } catch (err) {
          // Bulk insert gagal total (mis. race condition ada 1 guru yang barusan
          // absen manual di detik yang sama, bikin duplicate key untuk 1 baris saja
          // dan menggagalkan seluruh batch) - fallback ke insert satu-satu KHUSUS
          // untuk sekolah ini saja, supaya baris yang valid tetap tersimpan.
          console.error(`[${sekolahId}] Bulk insert gagal, fallback ke insert satu-satu:`, err.message);
          for (const baris of calonBaris) {
            try {
              await sbInsert(env, 'absen_masuk', baris);
              ditandaiDiSekolahIni++;
            } catch (err2) {
              if (!String(err2.message).includes('duplicate key')) console.error(`[${sekolahId}] Gagal insert 1 baris (${baris.nuptk}):`, err2.message);
            }
          }
        }
      }
      await invalidate(env, `ABSEN_MASUK_PERIODE_CACHE_${sekolahId}`);
      console.log(`[${sekolahId}] Selesai: ${ditandaiDiSekolahIni} guru ditandai Tanpa Keterangan. (${debugInfo})`);
      ringkasan.sekolahDiproses.push(`${sekolahId} (${ditandaiDiSekolahIni} ditandai — ${debugInfo})`);
      ringkasan.totalDitandaiAlpa += ditandaiDiSekolahIni;
    } catch (err) {
      // Sekolah ini gagal (mis. error koneksi Supabase, data settings korup, dll) -
      // dicatat, lalu LANJUT ke sekolah berikutnya, bukan berhenti total.
      console.error(`[${sekolahId}] GAGAL auto alpa:`, err.message);
      ringkasan.sekolahError.push(`${sekolahId}: ${err.message}`);
    }
  }
  return ringkasan;
}

/**
 * Dipanggil dari Cron Trigger (1x sehari, jam 21:00 WIB - setelah waktu Dzuhur MAUPUN
 * Ashar pasti sudah lewat), atau manual lewat tombol Admin Utama (jalankanAutoSholatManual).
 * Guru yang tidak pernah mengisi presensi Pendampingan Sholat Dzuhur dan/atau Ashar hari
 * itu (lewat menu Kegiatan Sekolah) akan otomatis ditandai "Tidak Absen" untuk sesi yang
 * terlewat - dulu kalau tidak absen datanya cuma kosong/tidak ada baris sama sekali di
 * kegiatan_umum, jadi tidak kelihatan di laporan sebagai bahan evaluasi. Sekarang selalu
 * ada baris eksplisit "Tidak Absen" untuk sesi yang benar-benar terlewat.
 *
 * Sengaja dicek Dzuhur DAN Ashar dalam 1 pemanggilan jam 21:00 WIB (bukan 2 cron terpisah
 * persis setelah tiap sesi) - lebih sederhana dan cukup aman karena jam 21:00 WIB kedua
 * sesi pasti sudah lewat jauh.
 *
 * Memakai toggle Admin yang sama dengan Auto Alpa Absen Masuk (settings.status_auto_alpa) -
 * supaya tidak perlu tambah menu Pengaturan baru; kalau nanti perlu tombol on/off terpisah
 * khusus otomasi sholat, tinggal ganti ke key settings baru di sini + tambah field di
 * form Pengaturan.
 */
export async function autoSetTidakAbsenSholat(env) {
  const JENIS_DICEK = ['SHOLAT_DZUHUR', 'SHOLAT_ASHAR'];
  const { dateStr, dayOfWeek } = nowJakarta();
  const ringkasan = { sekolahDiproses: [], sekolahDilewati: [], sekolahError: [], totalDitandaiTidakAbsen: 0 };

  if (dayOfWeek === 0 || dayOfWeek === 6) {
    console.log('[autoSetTidakAbsenSholat] Akhir pekan, dilewati untuk semua sekolah.');
    return ringkasan;
  }

  const daftarSekolah = await sbSelect(env, 'sekolah', "status=eq.Aktif");
  console.log(`[autoSetTidakAbsenSholat] Ditemukan ${daftarSekolah.length} sekolah berstatus Aktif untuk diproses (tanggal ${dateStr}).`);

  for (const sekolah of daftarSekolah) {
    const sekolahId = sekolah.id;
    try {
      const settings = await getSettingsMap(env, sekolahId);
      if ((settings.status_auto_alpa || 'Aktif') === 'Nonaktif') {
        console.log(`[${sekolahId}] Auto Alpa dinonaktifkan sementara oleh Admin, auto Tidak Absen Sholat dilewati.`);
        ringkasan.sekolahDilewati.push(`${sekolahId} (auto alpa nonaktif)`);
        continue;
      }

      const statusLibur = await checkApakahHariLibur(env, sekolahId, dateStr);
      if (statusLibur) {
        ringkasan.sekolahDilewati.push(`${sekolahId} (libur: ${statusLibur})`);
        continue;
      }

      const users = await getUsersListCached(env, sekolahId);

      // Kumpulkan dulu SEMUA baris yang perlu ditambahkan (Dzuhur + Ashar sekaligus,
      // lintas semua guru) baru kirim lewat bulk insert 1x per sekolah - bukan 1
      // request HTTP per (guru x sesi) dalam loop, supaya tidak menabrak limit
      // "Too many subrequests by single Worker invocation" di Cloudflare.
      const calonBaris = [];
      for (const jenisKegiatan of JENIS_DICEK) {
        const sudahAbsenHariIni = await sbSelect(env, 'kegiatan_umum', `sekolah_id=eq.${sekolahId}&tanggal=eq.${dateStr}&jenis_kegiatan=eq.${jenisKegiatan}`);
        const sudahAbsenNuptk = sudahAbsenHariIni.map((r) => String(r.nuptk).trim());

        for (const u of users) {
          const userRole = String(u.role).trim(), userStatus = String(u.status).trim();
          const userNuptk = String(u.nuptk).trim(), userNama = String(u.nama).trim();

          if (['GURU', 'KEPALA_SEKOLAH', 'PIKET', 'ADMIN_SEKOLAH'].includes(userRole) && userStatus === 'Aktif') {
            if (!sudahAbsenNuptk.includes(userNuptk)) {
              calonBaris.push({
                id: generateShortID('KO'), sekolah_id: sekolahId, jenis_kegiatan: jenisKegiatan, tanggal: dateStr,
                nuptk: userNuptk, nama: userNama, kegiatan: jenisKegiatan, status: 'Tidak Absen',
                catatan: 'Otomatis oleh sistem - tidak melakukan presensi sampai batas waktu.', timestamp: new Date().toISOString()
              });
            }
          }
        }
      }

      let ditandaiDiSekolahIni = 0;
      // Berhasil-insert per jenis DIHITUNG DARI HASIL SUNGGUH-SUNGGUH (bukan dari
      // calonBaris sebelum insert) - supaya kalau ternyata cuma sebagian yang benar-
      // benar tersimpan (mis. sebagian gagal di fallback per-baris), rinciannya tetap
      // akurat, bukan optimis mengasumsikan semua kandidat pasti berhasil.
      const berhasilPerJenis = { SHOLAT_DZUHUR: 0, SHOLAT_ASHAR: 0 };
      if (calonBaris.length) {
        try {
          const hasil = await sbInsertMany(env, 'kegiatan_umum', calonBaris);
          ditandaiDiSekolahIni = hasil.length;
          hasil.forEach((r) => { if (berhasilPerJenis[r.jenis_kegiatan] !== undefined) berhasilPerJenis[r.jenis_kegiatan]++; });
        } catch (err) {
          console.error(`[${sekolahId}] Bulk insert gagal, fallback ke insert satu-satu:`, err.message);
          for (const baris of calonBaris) {
            try {
              await sbInsert(env, 'kegiatan_umum', baris);
              ditandaiDiSekolahIni++;
              if (berhasilPerJenis[baris.jenis_kegiatan] !== undefined) berhasilPerJenis[baris.jenis_kegiatan]++;
            } catch (err2) {
              if (!String(err2.message).includes('duplicate key')) console.error(`[${sekolahId}] Gagal insert 1 baris (${baris.nuptk}, ${baris.jenis_kegiatan}):`, err2.message);
            }
          }
        }
      }
      const rincianJenis = `Dzuhur: ${berhasilPerJenis.SHOLAT_DZUHUR}, Ashar: ${berhasilPerJenis.SHOLAT_ASHAR}`;
      console.log(`[${sekolahId}] Selesai: ${ditandaiDiSekolahIni} baris Tidak Absen ditambahkan (${rincianJenis}).`);
      ringkasan.sekolahDiproses.push(`${sekolahId} (${ditandaiDiSekolahIni} ditandai — ${rincianJenis})`);
      ringkasan.totalDitandaiTidakAbsen += ditandaiDiSekolahIni;
    } catch (err) {
      console.error(`[${sekolahId}] GAGAL auto Tidak Absen Sholat:`, err.message);
      ringkasan.sekolahError.push(`${sekolahId}: ${err.message}`);
    }
  }
  return ringkasan;
}

/**
 * Trigger manual (bukan dari Cron) untuk Admin Utama - menjalankan otomasi Auto Alpa
 * Absen Masuk + Auto Tidak Absen Sholat SEKARANG JUGA, lalu mengembalikan ringkasan
 * hasil apa adanya (termasuk pesan error asli kalau ada yang gagal). Berguna untuk:
 * 1) Menguji apakah otomasi jalan dengan benar tanpa perlu menunggu jam cron.
 * 2) Menyusulkan/memperbaiki hari yang otomasinya sempat gagal/tidak jalan.
 */
/**
 * Trigger manual (bukan dari Cron) untuk Admin Utama - menjalankan HANYA Auto Alpa
 * Absen Masuk sekarang juga, lalu mengembalikan ringkasan hasil apa adanya.
 *
 * Sengaja dipisah dari otomasi Sholat (bukan digabung dalam 1 fungsi/1 eksekusi
 * Worker seperti sebelumnya) - supaya jumlah request ke Supabase per eksekusi tetap
 * kecil dan tidak menabrak limit "Too many subrequests by single Worker invocation",
 * sama seperti cara Cron Trigger asli menjalankan tiap otomasi di jadwal terpisah.
 */
async function jalankanAutoAlpaManual(args, env) {
  const [token] = args;
  const user = await requireUser(env, token);
  if (!isRole(user, 'ADMIN_UTAMA')) return { success: false, message: 'Hanya Admin Utama yang boleh menjalankan ini.' };

  const hasil = await autoSetTanpaKeterangan(env);
  return { success: true, absenMasuk: hasil };
}

/**
 * Sama seperti jalankanAutoAlpaManual() di atas, tapi untuk Auto "Tidak Absen"
 * Sholat Dzuhur/Ashar. Lihat catatan di jalankanAutoAlpaManual() soal kenapa
 * dipisah jadi 2 handler, bukan 1 gabungan.
 */
async function jalankanAutoSholatManual(args, env) {
  const [token] = args;
  const user = await requireUser(env, token);
  if (!isRole(user, 'ADMIN_UTAMA')) return { success: false, message: 'Hanya Admin Utama yang boleh menjalankan ini.' };

  const hasil = await autoSetTidakAbsenSholat(env);
  return { success: true, sholat: hasil };
}

// ====================================================================
// PETA NAMA FUNGSI -> HANDLER
// Nama-nama ini dipanggil langsung dari index.html lewat shim
// google.script.run (nama variabel dipertahankan untuk kompatibilitas,
// tapi isinya sekarang fetch() ke Worker ini - lihat komentar shim
// di index.html untuk detailnya).
// ====================================================================

export const handlers = {
  loginUser,
  checkSession: checkSessionFn,
  logout: logoutFn,
  getSekolahList,
  getLokasiAbsenTarget,
  saveAbsenMasuk,
  getAbsenMasukUntukEdit,
  updateAbsenMasuk,
  checkSudahAbsenKegiatan,
  saveKegiatan,
  saveAbsenKegiatanKhusus,
  tutupAbsenKegiatan,
  saveJadwalKegiatan,
  getJadwalKegiatan,
  toggleStatusKegiatan,
  deleteJadwalKegiatan,
  getDashboardData,
  getSettingsData,
  saveSettingsData,
  jalankanAutoAlpaManual,
  jalankanAutoSholatManual,
  getUsers,
  saveUser,
  updateUser,
  getGuruList,
  getGuruMengajarList,
  deleteUser,
  getStafAktifUntukImpal,
  saveHariLibur,
  getLiburList,
  deleteHariLibur,
  getPayrollReport,
  getReport,
  getRekapJamPelajaranSendiri,
  getPayrollJamPelajaran,
  saveRekapJamPelajaran,
  simpanTokenFCM
};
