import { sbSelect, sbSelectAll, sbInsert, sbInsertMany, sbUpdate, sbUpdateWhere, sbUpsertMany, sbDelete, sbDeleteWhere } from './supabase.js';
import { createSession, getSession, destroySession } from './session.js';
import { verifyAndMigratePassword, hashPassword } from './auth.js';
import { getSettingsMap } from './settings.js';
import { checkApakahHariLibur, hitungRadiusGPS } from './libur.js';
import { nowJakarta, getPeriodeBerjalan, getPeriodeByOffset, toDateStr } from './date.js';
import { cached, invalidate } from './cache.js';
import { kirimNotifikasiKeSatuHP } from './fcm.js';
import { uploadFileKeDrive, hapusFileDriveDariUrl, ambilFileIdDariUrl, driveSudahDisetup } from './drive.js';

/**
 * Ambil jam (HH:mm) dalam WIB dari sebuah timestamp yang disimpan pakai
 * `new Date().toISOString()` (UTC) - dipakai di kolom "timestamp" tabel
 * kegiatan_umum & absen_kegiatan_khusus (lihat saveKegiatan,
 * saveAbsenKegiatanKhusus). WIB = UTC+7 SELALU (tidak ada DST di Indonesia),
 * jadi cukup ditambah 7 jam manual - TIDAK BOLEH cuma parse timestamp lalu
 * .toISOString() lagi tanpa penyesuaian ini, itu akan mengembalikan jam
 * UTC-nya (mis. absen jam 07:15 WIB tersimpan sebagai 00:15Z, kalau dibaca
 * ulang tanpa +7 jam akan tampil "00:15" - persis bug "waktunya dini hari
 * padahal absen jam 7 pagi" yang dilaporkan guru).
 */
function jamWibDariTimestamp(ts) {
  if (!ts) return '00:00';
  try {
    const wib = new Date(new Date(ts).getTime() + 7 * 60 * 60 * 1000);
    return wib.toISOString().substr(11, 5);
  } catch (e) { return '00:00'; }
}

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

/**
 * Cek apakah suatu hari (0=Minggu...6=Sabtu, sama seperti dayOfWeek dari nowJakarta())
 * adalah hari libur MINGGUAN RUTIN untuk sekolah ybs - BUKAN hari libur nasional/khusus
 * (itu urusan checkApakahHariLibur() di libur.js, tanggal spesifik).
 *
 * Diatur lewat settings.hari_libur_mingguan (string angka dipisah koma, mis. "0,6").
 * Default "0,6" (Minggu+Sabtu) kalau admin belum pernah mengisi field ini - supaya
 * sekolah reguler (SDIT dkk) yang sudah ada dari awal tetap jalan seperti biasa tanpa
 * perlu setting apa-apa. Sekolah dengan pola beda (mis. MDT/DTA yang cuma libur Ahad)
 * tinggal isi "0" saja di menu Pengaturan.
 */
function isHariLiburMingguan(settings, dayOfWeek) {
  const raw = String(settings.hari_libur_mingguan || '0,6').trim();
  const hariLiburSet = raw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
  return hariLiburSet.includes(dayOfWeek);
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
    headers: ['ID', 'Tanggal', 'NUPTK', 'Nama', 'Jam Masuk', 'Latitude', 'Longitude', 'Jarak (m)', 'Jam Pulang', 'Latitude Pulang', 'Longitude Pulang', 'Jarak Pulang (m)', 'Status', 'Keterangan', 'Maps Link'],
    fields: ['id', 'tanggal', 'nuptk', 'nama', 'jam', 'latitude', 'longitude', 'jarak', 'jam_pulang', 'lat_pulang', 'long_pulang', 'jarak_pulang', 'status', 'keterangan', 'maps_link'],
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

const JENIS_LAPORAN_PESANTREN = ['DZIKIR_MAKHSUS', 'PENGAJIAN_AHAD', 'PENGAJIAN_ARBAIN', 'QINI_NASIONAL_SUBUH', 'QINI_NASIONAL_MALAM'];
const STATUS_ABSEN_VALID = ['Hadir', 'Terlambat', 'Sakit', 'Izin', 'Tugas Luar', 'Tanpa Keterangan', 'Cuti'];

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

/**
 * Ganti password mandiri - HANYA untuk role non-admin (GURU, KEPALA_SEKOLAH, PIKET).
 * Admin Sekolah/Admin Utama sengaja dikecualikan (permintaan ganti password mereka
 * tetap lewat jalur manual di luar aplikasi, mis. langsung ke Admin Utama/database).
 * Verifikasi password lama pakai verifyAndMigratePassword() yang sama dengan login -
 * otomatis menangani akun lama yang passwordnya masih plaintext juga.
 */
async function changePassword(args, env) {
  const [token, currentPassword, newPassword1, newPassword2] = args;
  const user = await requireUser(env, token);
  if (!user) return { success: false, message: 'Sesi habis, silakan login ulang.' };

  if (isAdminAny(user)) {
    return { success: false, message: 'Fitur ganti password mandiri tidak tersedia untuk role Anda.' };
  }
  if (!currentPassword || !newPassword1 || !newPassword2) {
    return { success: false, message: 'Semua kolom wajib diisi.' };
  }
  if (newPassword1 !== newPassword2) {
    return { success: false, message: 'Password baru dan konfirmasi tidak sama. Silakan periksa kembali.' };
  }
  if (String(newPassword1).trim().length < 6) {
    return { success: false, message: 'Password baru minimal 6 karakter.' };
  }

  const rows = await sbSelect(env, 'users', `nuptk=eq.${encodeURIComponent(user.nuptk)}&limit=1`);
  const userRow = rows[0];
  if (!userRow) return { success: false, message: 'Akun tidak ditemukan.' };

  const cocok = await verifyAndMigratePassword(env, userRow, String(currentPassword).trim());
  if (!cocok) return { success: false, message: 'Password saat ini salah.' };

  const newHash = await hashPassword(String(newPassword1).trim());
  await sbUpdate(env, 'users', 'nuptk', user.nuptk, { password: newHash });

  return { success: true, message: 'Password berhasil diubah. Gunakan password baru saat login berikutnya.' };
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
    },
    jamBolehPulang: settings.jam_boleh_pulang || '15:30'
  };
}

async function saveAbsenMasuk(args, env) {
  const [token, status, keterangan, lat, lon] = args;
  const user = await requireUser(env, token);
  if (!user) return { success: false, message: 'Sesi habis, silakan login ulang.' };
  const sekolahId = user.sekolahId; // absen selalu untuk sekolah sendiri, tidak ada skenario admin utama absen

  // Pengaman tambahan di belakang validasi frontend (dropdown placeholder wajib
  // dipilih): tolak juga di sini kalau status kosong/tidak dikenal, supaya
  // pemanggilan API langsung tanpa lewat form tidak bisa lolos dengan status
  // kosong yang ambigu.
  const STATUS_ABSEN_MASUK_VALID = ['Hadir & Tawasul', 'Hadir', 'Sakit', 'Izin', 'Tugas Luar'];
  if (!STATUS_ABSEN_MASUK_VALID.includes(status)) {
    return { success: false, message: 'Status kehadiran belum dipilih atau tidak dikenal. Silakan pilih ulang.' };
  }

  const { dateStr, timeStr: jamLaporStr, dayOfWeek } = nowJakarta();
  const settings = await getSettingsMap(env, sekolahId);

  let statusLiburSistem = '';
  if (isHariLiburMingguan(settings, dayOfWeek)) {
    statusLiburSistem = 'Libur Akhir Pekan';
  } else {
    const namaLiburNasional = await checkApakahHariLibur(env, sekolahId, dateStr);
    if (namaLiburNasional) statusLiburSistem = 'Libur Nasional: ' + namaLiburNasional;
  }
  if (statusLiburSistem !== '') {
    return { success: false, message: `Absen Ditolak! Hari ini sistem dinonaktifkan karena agenda [${statusLiburSistem}].` };
  }

  const existing = await sbSelect(env, 'absen_masuk', `nuptk=eq.${encodeURIComponent(user.nuptk)}&tanggal=eq.${dateStr}&limit=1`);
  if (existing.length > 0) {
    return { success: false, message: `Anda sudah melakukan absen masuk hari ini pada pukul ${existing[0].jam} WIB.` };
  }

  if (!lat || !lon || lat === '-' || lon === '-') {
    return { success: false, message: 'Gagal memverifikasi koordinat GPS. Pastikan izin lokasi aktif.' };
  }

  let finalStatus = status;
  const mapsLink = `https://www.google.com/maps?q=${lat},${lon}`;
  const jarakMeter = hitungRadiusGPS(parseFloat(lat), parseFloat(lon), parseFloat(settings.lat_sekolah), parseFloat(settings.long_sekolah));

  // "Hadir & Tawasul" dianggap identik dengan "Hadir" untuk keperluan validasi GPS,
  // keterlambatan, dan status final yang tersimpan di tabel absen_masuk (supaya rekap
  // payroll/kehadiran yang sudah ada tidak perlu tahu soal Tawasul sama sekali - tetap
  // Hadir/Terlambat seperti biasa). Bedanya cuma: ada efek samping mencatat kehadiran
  // Briefing & Tawasul di bawah, menggantikan absen manual terpisah yang dulu ada.
  const inginTawasul = status === 'Hadir & Tawasul';
  if (status === 'Hadir' || inginTawasul) {
    if (jarakMeter > parseInt(settings.radius || 50, 10)) {
      return { success: false, message: `Posisi Anda berada di luar radius sekolah (${jarakMeter} meter). Silakan mendekat ke area sekolah.` };
    }
    const [jamMasukH, jamMasukM] = settings.jam_masuk.split(':').map(Number);
    const [jamLaporH, jamLaporM] = jamLaporStr.split(':').map(Number);
    const menitBatas = jamMasukH * 60 + jamMasukM + parseInt(settings.toleransi || 15, 10);
    const menitLapor = jamLaporH * 60 + jamLaporM;
    finalStatus = menitLapor > menitBatas ? 'Terlambat' : 'Hadir';
  }

  // Guru yang pilih "Hadir & Tawasul" TAPI ternyata datang lewat batas toleransi
  // (finalStatus jadi 'Terlambat') TIDAK dianggap ikut Tawasul - datang terlambat
  // berarti briefing & tawasul sudah pasti terlewat, jadi jangan sampai tercatat
  // seolah-olah hadir di kegiatan itu. Baru dianggap ikut Tawasul kalau benar-benar
  // tepat waktu (finalStatus tetap 'Hadir').
  const ikutTawasul = inginTawasul && finalStatus !== 'Terlambat';

  // Catatan "Ikut Tawasul" di kolom Keterangan laporan Absen Masuk sengaja dibangun
  // DI SINI (backend), BUKAN disisipkan di frontend saat guru klik dropdown seperti
  // implementasi lama - karena saat itu diklik, status akhir (Hadir/Terlambat) BELUM
  // diketahui (baru dihitung server di atas). Dengan dibangun dari ikutTawasul yang
  // sudah pasti benar ini, catatan "Ikut Tawasul" TIDAK PERNAH bisa nempel ke guru
  // yang ternyata terlambat. Keterangan tulisan guru sendiri (kalau ada) tetap
  // ditambahkan setelahnya, dipisah " - ".
  const catatanGuru = (keterangan || '').trim();
  const finalKeterangan = ikutTawasul
    ? (catatanGuru ? `Ikut Tawasul - ${catatanGuru}` : 'Ikut Tawasul')
    : (catatanGuru || '-');

  try {
    await sbInsert(env, 'absen_masuk', {
      id: generateShortID('AB'), sekolah_id: sekolahId, tanggal: dateStr, nuptk: user.nuptk, nama: user.nama,
      jam: jamLaporStr, latitude: String(lat), longitude: String(lon), jarak: jarakMeter,
      status: finalStatus, keterangan: finalKeterangan, maps_link: mapsLink
    });
  } catch (err) {
    if (String(err.message).includes('duplicate key')) {
      return { success: false, message: 'Anda sudah melakukan absen masuk hari ini.' };
    }
    throw err;
  }
  await invalidate(env, `ABSEN_MASUK_PERIODE_CACHE_${sekolahId}`);

  if (ikutTawasul) {
    // Catat juga sebagai kehadiran Briefing & Tawasul (jenis kegiatan yang sama dengan
    // yang dulu diisi manual lewat menu Kegiatan Sekolah) - supaya laporan Briefing &
    // Tawasul tetap jalan tanpa guru perlu absen 2x. Kalau gagal (mis. race condition
    // duplicate key), jangan sampai membatalkan absen masuk yang sudah tersimpan -
    // absen masuk tetap prioritas utama.
    try {
      await sbInsert(env, 'kegiatan_umum', {
        id: generateShortID('K'), sekolah_id: sekolahId, jenis_kegiatan: 'BRIEFING_TAWASUL', tanggal: dateStr,
        nuptk: user.nuptk, nama: user.nama, kegiatan: 'BRIEFING_TAWASUL', status: 'Hadir',
        catatan: 'Otomatis tercatat dari Absen Masuk (Hadir & Tawasul).', timestamp: new Date().toISOString()
      });
    } catch (err) {
      if (!String(err.message).includes('duplicate key')) console.error('Gagal mencatat kehadiran Briefing & Tawasul otomatis:', err.message);
    }
  }

  let pesanSukses = `Absen berhasil disimpan pada pukul ${jamLaporStr} WIB.`;
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

/**
 * Baris absen_masuk milik guru yang login, HARI INI SAJA - dipakai frontend untuk
 * menampilkan status "sudah Masuk jam berapa / sudah Pulang jam berapa" begitu
 * menu Absen Masuk dibuka (mirip contoh tampilan Check in / Check out yang
 * diberikan Admin), dan untuk memutuskan tombol mana yang boleh aktif. SENGAJA
 * dibuat handler baru terpisah dari getLokasiAbsenTarget() (yang datanya
 * di-cache sekali per sesi login di frontend) - status hari ini harus SELALU
 * fresh, tidak boleh ikut ke-cache.
 */
async function getStatusAbsenHariIni(args, env) {
  const [token] = args;
  const user = await requireUser(env, token);
  if (!user) return null;
  const { dateStr } = nowJakarta();
  const rows = await sbSelect(env, 'absen_masuk', `sekolah_id=eq.${user.sekolahId}&tanggal=eq.${dateStr}&nuptk=eq.${encodeURIComponent(user.nuptk)}`);
  return rows.length ? rows[0] : null;
}

/**
 * Absen PULANG - pasangan dari saveAbsenMasuk() di atas, tapi meng-UPDATE baris
 * absen_masuk hari ini (bukan INSERT baris baru) karena secara konsep ini melengkapi
 * baris absen yang sama, bukan kejadian terpisah. Guru harus sudah Absen Masuk
 * hari ini dulu (tidak bisa langsung Pulang tanpa Masuk), dan cuma bisa dilakukan
 * SEKALI (kolom jam_pulang harus masih kosong) - dijaga di level query (bukan cuma
 * dicek lalu percaya begitu saja) lewat filter jam_pulang=is.null di WHERE UPDATE-
 * nya sendiri, supaya aman dari race condition 2 tab/perangkat sekaligus.
 *
 * GPS tetap divalidasi (radius sekolah yang sama seperti Absen Masuk) - beda dengan
 * fitur "pulang cepat" (dicatat manual oleh Piket/Admin, dibahas terpisah) yang
 * memang tidak butuh GPS karena bukan aksi mandiri guru.
 *
 * Setelah berhasil, sekalian memicu trigerAutoAlpaOportunistik() untuk sekolah ini -
 * lihat komentar di fungsi itu untuk alasannya (akal-akalan hemat slot Cron Trigger
 * Cloudflare).
 */
async function saveAbsenPulang(args, env) {
  const [token, lat, lon] = args;
  const user = await requireUser(env, token);
  if (!user) return { success: false, message: 'Sesi habis, silakan login ulang.' };
  const sekolahId = user.sekolahId;
  const { dateStr, timeStr } = nowJakarta();

  const rows = await sbSelect(env, 'absen_masuk', `sekolah_id=eq.${sekolahId}&tanggal=eq.${dateStr}&nuptk=eq.${encodeURIComponent(user.nuptk)}`);
  const rowHariIni = rows.length ? rows[0] : null;
  if (!rowHariIni) {
    return { success: false, message: 'Anda belum melakukan Absen Masuk hari ini, jadi belum bisa Absen Pulang.' };
  }
  if (rowHariIni.jam_pulang) {
    return { success: false, message: 'Anda sudah melakukan Absen Pulang hari ini pada pukul ' + rowHariIni.jam_pulang + ' WIB.' };
  }
  if (!['Hadir', 'Terlambat'].includes(String(rowHariIni.status).trim())) {
    return { success: false, message: 'Absen Pulang cuma berlaku untuk guru yang hadir fisik di sekolah hari ini.' };
  }

  const settings = await getSettingsMap(env, sekolahId);

  // Pengaman di belakang tombol yang sudah dikunci di frontend sebelum jam ini -
  // ditolak juga di sini supaya tidak bisa dilewati dengan memanggil API langsung.
  const jamBolehPulang = settings.jam_boleh_pulang || '15:30';
  if (timeStr < jamBolehPulang) {
    return { success: false, message: `Absen Pulang baru bisa dilakukan mulai pukul ${jamBolehPulang} WIB, sesuai tata tertib sekolah.` };
  }

  const jarakMeter = hitungRadiusGPS(parseFloat(lat), parseFloat(lon), parseFloat(settings.lat_sekolah), parseFloat(settings.long_sekolah));
  if (jarakMeter > parseInt(settings.radius || 50, 10)) {
    return { success: false, message: `Posisi Anda berada di luar radius sekolah (${jarakMeter} meter). Silakan mendekat ke area sekolah.` };
  }

  const hasil = await sbUpdateWhere(env, 'absen_masuk',
    { sekolah_id: sekolahId, tanggal: dateStr, nuptk: user.nuptk, jam_pulang: null },
    { jam_pulang: timeStr, lat_pulang: String(lat), long_pulang: String(lon), jarak_pulang: jarakMeter });
  if (!hasil) {
    // Filter jam_pulang=null di atas tidak menemukan baris (race condition - sudah
    // ke-update duluan oleh request lain di detik yang sama).
    return { success: false, message: 'Anda sudah melakukan Absen Pulang hari ini.' };
  }
  await invalidate(env, `ABSEN_MASUK_PERIODE_CACHE_${sekolahId}`);

  // Efek samping: manfaatkan momen ada aktivitas nyata di sekolah ini untuk sekalian
  // mengecek apakah sudah waktunya menandai guru lain yang belum Absen Masuk sebagai
  // Tanpa Keterangan - lihat komentar di trigerAutoAlpaOportunistik(). Tidak di-await
  // dengan menghalangi respons ke guru (biar Absen Pulang tetap terasa instan),
  // tapi tetap dijamin selesai lewat waitUntil-style try/catch di dalam fungsinya
  // sendiri - kalaupun gagal, tidak mempengaruhi keberhasilan Absen Pulang ini.
  await trigerAutoAlpaOportunistik(env, sekolahId);

  // Efek samping lain dari momen yang sama: ada guru yang sudah pulang berarti
  // sudah masuk "sore hari" di sekolah ini - momen pas untuk sekalian
  // mengingatkan guru LAIN yang belum Sholat Dzuhur/Ashar dan/atau belum
  // Absen Pulang. Lihat komentar lengkap di trigerPengingatPulangOportunistik().
  await trigerPengingatPulangOportunistik(env, sekolahId);

  return { success: true, message: `Absen Pulang berhasil disimpan pada pukul ${timeStr} WIB. Hati-hati di jalan, sampai jumpa besok!` };
}

/**
 * Dulu cuma query langsung ke tabel absen_masuk - jadi kalau auto-absen "Tanpa
 * Keterangan" gagal jalan untuk seorang guru (lihat prosesAutoAlpaSatuSekolah:
 * bisa gagal karena error Supabase, limit subrequest Worker, dll), guru itu
 * TIDAK PUNYA BARIS SAMA SEKALI untuk tanggal itu, sehingga tidak pernah muncul
 * di sini - admin terpaksa buka Supabase manual untuk menambahkan barisnya.
 *
 * Sekarang mulai dari ROSTER staf aktif sekolah (kriteria kelayakan SAMA
 * PERSIS seperti prosesAutoAlpaSatuSekolah: role GURU/KEPALA_SEKOLAH/PIKET/
 * ADMIN_SEKOLAH + status Aktif), lalu digabung dengan baris absen_masuk yang
 * memang sudah ada. Guru yang TIDAK punya baris (dan sedang TIDAK cuti/sakit -
 * guru cuti seharusnya sudah dapat baris asli lewat backfill saveCutiGuru,
 * ini cuma jaring pengaman kalau backfill itu kebetulan gagal) ditampilkan
 * sebagai baris "placeholder" dengan docId null, status default 'Tanpa
 * Keterangan', dan flag belumAdaData - updateAbsenMasuk() akan INSERT baris
 * baru (bukan UPDATE) kalau docId dikirim kosong. Baris placeholder ditaruh
 * PALING ATAS hasil supaya langsung kelihatan admin tanpa perlu scroll/cari.
 */
async function getAbsenMasukUntukEdit(args, env) {
  const [token, tanggal, filterNuptk, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user)) return { keteranganLibur: null, data: [] };
  const sekolahId = resolveSekolahId(user, requestedSekolahId);

  const dateStr = tanggal || nowJakarta().dateStr;

  // Cek dulu apakah tanggal ini hari libur (mingguan ATAU kalender libur
  // khusus sekolah) - kalau libur, JANGAN buat baris "Belum Ada Data" untuk
  // semua guru, karena memang wajar tidak ada yang absen di hari libur (itu
  // bukan tanda auto-absen gagal). Data yang SUNGGUHAN ada (mis. ada guru
  // yang kebetulan piket/lembur di hari libur) tetap ditampilkan seperti
  // biasa - cuma placeholder-nya yang di-skip.
  const settingsSekolah = await getSettingsMap(env, sekolahId);
  const dayOfWeek = new Date(dateStr).getUTCDay();
  const liburKhusus = await checkApakahHariLibur(env, sekolahId, dateStr);
  const keteranganLibur = isHariLiburMingguan(settingsSekolah, dayOfWeek)
    ? (liburKhusus || 'Hari libur mingguan sekolah')
    : liburKhusus;

  const [users, rows, guruCutiMap] = await Promise.all([
    getUsersListCached(env, sekolahId),
    sbSelect(env, 'absen_masuk', `sekolah_id=eq.${sekolahId}&tanggal=eq.${dateStr}`),
    keteranganLibur ? Promise.resolve({}) : getGuruCutiAktifHariIni(env, sekolahId, dateStr)
  ]);

  const rowByNuptk = {};
  rows.forEach((r) => { rowByNuptk[String(r.nuptk).trim()] = r; });

  const hasil = [];
  users.forEach((u) => {
    const userRole = String(u.role).trim(), userStatus = String(u.status).trim(), nuptk = String(u.nuptk).trim();
    if (!['GURU', 'KEPALA_SEKOLAH', 'PIKET', 'ADMIN_SEKOLAH'].includes(userRole) || userStatus !== 'Aktif') return;

    const existing = rowByNuptk[nuptk];
    if (existing) {
      hasil.push({
        docId: existing.id, nuptk: existing.nuptk, nama: existing.nama, tanggal: existing.tanggal,
        jam: existing.jam, status: existing.status, keterangan: existing.keterangan, belumAdaData: false
      });
    } else if (!keteranganLibur && !guruCutiMap[nuptk]) {
      hasil.push({
        docId: null, nuptk, nama: u.nama, tanggal: dateStr, jam: null, status: 'Tanpa Keterangan',
        keterangan: 'Belum ada data absen', belumAdaData: true
      });
    }
  });

  const filterTarget = String(filterNuptk || 'ALL').trim();
  const data = hasil
    .filter((r) => filterTarget === 'ALL' || String(r.nuptk).trim() === filterTarget)
    .sort((a, b) => {
      if (a.belumAdaData !== b.belumAdaData) return a.belumAdaData ? -1 : 1;
      return String(a.jam).localeCompare(String(b.jam));
    });

  return { keteranganLibur, data };
}

async function updateAbsenMasuk(args, env) {
  const [token, docId, jamBaru, statusBaru, keteranganBaru, nuptkBaru, tanggalBaru] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user)) return { success: false, message: 'Akses ditolak. Hanya Admin yang bisa mengubah data absen.' };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(jamBaru).trim())) {
    return { success: false, message: 'Format jam tidak valid. Gunakan format HH:mm, contoh 07:15.' };
  }
  if (!STATUS_ABSEN_VALID.includes(statusBaru)) return { success: false, message: 'Status tidak dikenal: ' + statusBaru };

  // docId kosong = baris placeholder dari getAbsenMasukUntukEdit() (guru belum
  // punya baris sama sekali untuk tanggal ini) - INSERT baru, bukan UPDATE.
  // nuptkBaru/tanggalBaru WAJIB dikirim frontend di kasus ini karena tidak ada
  // baris existing untuk diambil datanya.
  if (!docId) {
    if (!nuptkBaru || !tanggalBaru) {
      return { success: false, message: 'Data guru/tanggal tidak lengkap untuk membuat baris absen baru.' };
    }
    const staf = await sbSelect(env, 'users', `nuptk=eq.${encodeURIComponent(nuptkBaru)}&limit=1`);
    const target = staf[0];
    if (!target) return { success: false, message: 'Data guru tidak ditemukan.' };
    if (user.role === 'ADMIN_SEKOLAH' && target.sekolah_id !== user.sekolahId) {
      return { success: false, message: 'Akses ditolak. Guru ini bukan dari sekolah Anda.' };
    }

    // Cek dulu barangkali barisnya keburu dibuat sistem (mis. auto-absen jalan
    // tepat di detik yang sama saat admin sedang membuka modal ini) - hindari
    // duplicate key, sekalian update kalau ternyata sudah ada.
    const sudahAda = await sbSelect(env, 'absen_masuk',
      `sekolah_id=eq.${target.sekolah_id}&tanggal=eq.${tanggalBaru}&nuptk=eq.${encodeURIComponent(nuptkBaru)}&limit=1`);
    if (sudahAda.length) {
      await sbUpdate(env, 'absen_masuk', 'id', sudahAda[0].id, { jam: String(jamBaru).trim(), status: statusBaru, keterangan: keteranganBaru || '-' });
    } else {
      await sbInsert(env, 'absen_masuk', {
        id: generateShortID('AE'), sekolah_id: target.sekolah_id, tanggal: tanggalBaru, nuptk: nuptkBaru, nama: target.nama,
        jam: String(jamBaru).trim(), latitude: null, longitude: null, jarak: null,
        status: statusBaru, keterangan: keteranganBaru || '-', maps_link: '-'
      });
    }
    await invalidate(env, `ABSEN_MASUK_PERIODE_CACHE_${target.sekolah_id}`);
    return { success: true, message: `Data absen ${target.nama} tanggal ${tanggalBaru} berhasil dibuat.` };
  }

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
  const waktu = row.timestamp ? jamWibDariTimestamp(row.timestamp) : (row.waktu_lapor || '');
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
    return { success: false, message: `Ditolak! Anda sudah melakukan absen untuk kegiatan "${namaKegiatanStr}" hari ini.` };
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
      return { success: false, message: `Ditolak! Anda berada sekitar ${Math.round(jarakMeter)} meter dari lokasi kegiatan (maksimal ${radiusKegiatan} meter). Pastikan Anda sudah berada di lokasi acara sebelum absen.` };
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
    ? Math.round(hitungRadiusGPS(parseFloat(lat), parseFloat(lon), parseFloat(latKegiatan), parseFloat(lonKegiatan)))
    : null;

  await sbInsert(env, 'absen_kegiatan_khusus', {
    id: generateShortID('AK'), sekolah_id: sekolahId, tanggal_lapor: dateStr, waktu_lapor: jamLaporStr, nuptk: user.nuptk,
    nama: user.nama, nama_kegiatan: namaKegiatanStr, status_kehadiran: finalStatus,
    catatan: catatan || '', latitude: lat || null, longitude: lon || null, jarak: jarakTercatat
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
          catatan: 'Tidak Absen (Absen Ditutup Admin)', latitude: null, longitude: null, jarak: null
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
  // Dulu dashboard sengaja dibatasi tampilan mingguan (bukan periode payroll
  // 21-20 penuh) untuk menghemat kuota "document reads" Firestore. Sejak
  // migrasi ke Supabase (PostgreSQL) batasan itu sudah tidak berlaku - Supabase
  // tidak memungut biaya/kuota per baris yang dibaca, jadi periode bulanan penuh
  // sama ringannya dengan seminggu. Disamakan dengan getPeriodeBerjalan() yang
  // sudah dipakai di Rekap Payroll, supaya dashboard & laporan konsisten -
  // sekaligus otomatis menghitung hari Sabtu untuk sekolah seperti DTA yang
  // sebelumnya tidak pernah ikut terhitung oleh getMingguIniSeninJumat().
  const periodeBerjalanDash = getPeriodeBerjalan();

  let data = {
    todayStatus: 'Belum Absen', hadir: 0, terlambat: 0, izin: 0, sakit: 0, tugas_luar: 0, alpa_guru: 0,
    totalGuru: 0, adHadir: 0, adTerlambat: 0, adIzin: 0, adSakit: 0, adTugasLuar: 0, adBelum: 0,
    listBelumAbsen: [], periodeLabel: periodeBerjalanDash.label,
    periodeKeterangan: 'Rekap periode penggajian berjalan (tanggal 21 - 20). Gunakan filter di atas untuk cek periode lain.',
    listHadir: [], listTerlambat: [], listSakit: [], listIzin: [], listTugasLuar: [], listAlpa: []
  };

  let apakahHariLibur = false;
  const settingsDash = await getSettingsMap(env, sekolahId);
  if (isHariLiburMingguan(settingsDash, dayOfWeek)) {
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
    sDate = periodeBerjalanDash.start; eDate = periodeBerjalanDash.end;
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
        // 'Cuti' digabung ke bucket Sakit yang sama ("Sakit / Cuti") - baris
        // berstatus Cuti sudah otomatis dibuatkan (backfill) oleh saveCutiGuru()
        // untuk tiap hari kerja dalam rentang yang didaftarkan admin, jadi
        // cukup dibaca langsung dari sini, TIDAK PERLU query ulang tabel
        // cuti_guru secara terpisah (itu tadinya menyebabkan hitungan dobel
        // untuk entri berstatus Sakit).
        else if (statusAbsen === 'Sakit' || statusAbsen === 'Cuti') data.adSakit++;
        else if (statusAbsen === 'Tugas Luar') data.adTugasLuar++;
        else if (statusAbsen === 'Tanpa Keterangan') data.adBelum++;
      }
    }

    if (nuptkGuru === String(user.nuptk).trim()) {
      if (rowDateStr === dateStr) data.todayStatus = statusAbsen;
      const sDateGuru = startDate && endDate ? new Date(startDate) : periodeBerjalanDash.start;
      const eDateGuru = startDate && endDate ? new Date(endDate) : periodeBerjalanDash.end;
      const rowDateObjGuru = new Date(rowDateStr);
      if (rowDateObjGuru >= sDateGuru && rowDateObjGuru <= eDateGuru) {
        if (statusAbsen === 'Hadir') data.hadir++;
        else if (statusAbsen === 'Terlambat') data.terlambat++;
        else if (statusAbsen === 'Izin') data.izin++;
        else if (statusAbsen === 'Sakit' || statusAbsen === 'Cuti') data.sakit++;
        else if (statusAbsen === 'Tugas Luar') data.tugas_luar++;
        else if (statusAbsen === 'Tanpa Keterangan') data.alpa_guru++;
      }
    }

    if (rowDateStr === dateStr) {
      sudahAbsenHariIni.push(nuptkGuru);
      statusGuruHariIni[nuptkGuru] = { nama: namaGuru, status: statusAbsen };
    }
  });

  // Guru yang sedang dalam rentang Cuti/Sakit terdaftar (menu Cuti/Sakit Guru)
  // HARI INI harus dikecualikan dari daftar "Belum Absen/Alpa" di bawah -
  // mereka memang tidak diharapkan absen_masuk hari ini (sama seperti
  // pengecualian di auto-alfa), jadi kalau tidak dicek di sini akan salah
  // muncul di daftar alpa padahal cutinya sah.
  const guruCutiHariIni = await getGuruCutiAktifHariIni(env, sekolahId, dateStr);

  users.forEach((u) => {
    const uNuptk = String(u.nuptk).trim(), uNama = String(u.nama).trim();
    const uRole = String(u.role).trim(), uStatus = String(u.status).trim();
    if (['GURU', 'KEPALA_SEKOLAH', 'PIKET', 'ADMIN_SEKOLAH'].includes(uRole) && uStatus === 'Aktif') {
      if (!sudahAbsenHariIni.includes(uNuptk)) {
        if (guruCutiHariIni[uNuptk]) {
          data.listSakit.push(uNama); // sedang Cuti/Sakit terdaftar admin, bukan alpa
        } else if (!apakahHariLibur) {
          data.listBelumAbsen.push({ nuptk: uNuptk, nama: uNama }); data.listAlpa.push(uNama);
        }
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

/**
 * Data untuk 4 chart di Admin Panel: tren kehadiran harian, ranking guru
 * paling sering telat/alpa, distribusi jam datang, dan kepatuhan kegiatan
 * rutin (Briefing & Tawasul/Dzuhur/Ashar). SEMUANYA memakai rentang yang
 * sama: periode payroll berjalan (21 - 20), dipotong sampai hari ini.
 * Sengaja dipisah dari getDashboardData() karena rentang tanggalnya SELALU
 * tetap - tidak ikut filter tanggal kartu status di atasnya, jadi lebih
 * jelas kalau independen.
 */
async function getDashboardCharts(args, env) {
  const [token, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!user || (!isAdminAny(user) && !isRole(user, 'PIKET', 'KEPALA_SEKOLAH'))) return null;
  const sekolahId = resolveSekolahId(user, requestedSekolahId);

  const { dateStr: todayStr } = nowJakarta();
  const today = new Date(todayStr);

  // Periode payroll berjalan (21 - 20), dipotong sampai HARI INI saja
  // (jangan sampai tanggal-tanggal masa depan yang belum ada datanya ikut
  // dihitung sebagai "0 kejadian" yang menyesatkan).
  const periode = getPeriodeBerjalan();
  const periodeStartStr = toDateStr(periode.start);
  const periodeEndStrFull = toDateStr(periode.end);
  const periodeEndEfektifStr = todayStr < periodeEndStrFull ? todayStr : periodeEndStrFull;

  // Kegiatan rutin diambil PER JENIS (dan hanya status yang dihitung, hanya 2
  // kolom) - kalau digabung satu query, 3 jenis x staf x hari kerja satu periode
  // bisa melewati batas 1000 baris per request PostgREST dan hasilnya diam-diam
  // terpotong (persentase jadi lebih rendah dari kenyataan).
  const JENIS_KEGIATAN_RUTIN = [
    { key: 'BRIEFING_TAWASUL', label: 'Briefing & Tawasul' },
    { key: 'SHOLAT_DZUHUR', label: 'Dzuhur' },
    { key: 'SHOLAT_ASHAR', label: 'Ashar' }
  ];
  // Status yang DIHITUNG per jenis, bukan cuma 'Hadir':
  // BRIEFING_TAWASUL statusnya 'Hadir' (auto-tercatat dari Absen Masuk, lihat
  // saveAbsenMasuk). SHOLAT_DZUHUR/SHOLAT_ASHAR dipilih guru sendiri dari opsi
  // 'Berjamaah'/'Munfarid'/'Bertugas'/'Izin Terkonfirmasi'/'Haid'/'Sakit'
  // (lihat OPSI_STATUS_SHOLAT di index.html). Aturan sekolah: WAJIB Berjamaah
  // (atau Bertugas di tempat lain saat itu) - Munfarid (sholat sendirian) di
  // LUAR aturan itu, jadi SENGAJA tidak dihitung walau tetap berarti sholat.
  // Haid dihitung karena itu alasan lumrah/sah (bukan pelanggaran aturan).
  // 'Izin Terkonfirmasi'/'Sakit' tidak dihitung.
  const STATUS_DIHITUNG_PER_JENIS = {
    BRIEFING_TAWASUL: ['Hadir'],
    SHOLAT_DZUHUR: ['Berjamaah', 'Bertugas', 'Haid'],
    SHOLAT_ASHAR: ['Berjamaah', 'Bertugas', 'Haid']
  };

  const [users, settingsChart, rowsPeriode, liburList, ...rowsKegiatanPerJenis] = await Promise.all([
    getUsersListCached(env, sekolahId),
    getSettingsMap(env, sekolahId),
    sbSelect(env, 'absen_masuk', `sekolah_id=eq.${sekolahId}&tanggal=gte.${periodeStartStr}&tanggal=lte.${periodeEndEfektifStr}`),
    getLiburListCached(env, sekolahId),
    ...JENIS_KEGIATAN_RUTIN.map((j) =>
      sbSelect(env, 'kegiatan_umum',
        `select=jenis_kegiatan,status&sekolah_id=eq.${sekolahId}&tanggal=gte.${periodeStartStr}&tanggal=lte.${periodeEndEfektifStr}` +
        `&jenis_kegiatan=eq.${j.key}&status=in.(${STATUS_DIHITUNG_PER_JENIS[j.key].map(encodeURIComponent).join(',')})`)
    )
  ]);

  const totalStafAktif = users.filter((u) =>
    ['GURU', 'KEPALA_SEKOLAH', 'PIKET', 'ADMIN_SEKOLAH'].includes(String(u.role).trim()) && String(u.status).trim() === 'Aktif'
  ).length;

  // Hari kerja efektif dalam periode (dari tanggal 21 sampai hari ini): bukan
  // hari libur mingguan & bukan tanggal merah/libur sekolah. Dipakai bersama
  // oleh Tren Kehadiran (sumbu X) dan Kepatuhan Kegiatan (penyebut). Daftar
  // libur dibaca SEKALI lalu dicek lokal - bukan 1x baca KV per tanggal.
  const NAMA_HARI_SINGKAT = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
  const NAMA_BULAN_SINGKAT = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const adaLibur = (ds) => {
    const t = new Date(ds).getTime();
    return liburList.some((l) => t >= new Date(l.tgl_mulai).getTime() && t <= new Date(l.tgl_selesai).getTime());
  };
  const hariKerjaPeriode = [];
  for (let d = new Date(periodeStartStr); toDateStr(d) <= periodeEndEfektifStr; d.setUTCDate(d.getUTCDate() + 1)) {
    const ds = toDateStr(d);
    if (isHariLiburMingguan(settingsChart, d.getUTCDay())) continue;
    if (adaLibur(ds)) continue;
    hariKerjaPeriode.push({ ds, dow: d.getUTCDay(), tgl: d.getUTCDate(), bln: d.getUTCMonth() });
  }

  // --- 1) TREN KEHADIRAN: per hari kerja dalam periode berjalan -> jumlah Hadir/Terlambat/Tanpa Keterangan ---
  const trenMap = {};
  hariKerjaPeriode.forEach((h, idx) => {
    trenMap[h.ds] = {
      // Awal periode & tiap awal bulan diberi nama bulan ("1 Okt") supaya
      // lompatan 30 -> 1 di sumbu X tidak membingungkan.
      tanggal: h.ds, label: (idx === 0 || h.tgl === 1) ? `${h.tgl} ${NAMA_BULAN_SINGKAT[h.bln]}` : String(h.tgl),
      labelLengkap: `${NAMA_HARI_SINGKAT[h.dow]}, ${h.tgl} ${NAMA_BULAN_SINGKAT[h.bln]}`,
      hadir: 0, terlambat: 0, alpa: 0
    };
  });
  rowsPeriode.forEach((r) => {
    const bucket = trenMap[r.tanggal];
    if (!bucket) return; // data di hari libur/akhir pekan tidak dimunculkan di tren
    const st = String(r.status).trim();
    if (st === 'Hadir') bucket.hadir++;
    else if (st === 'Terlambat') bucket.terlambat++;
    else if (st === 'Tanpa Keterangan') bucket.alpa++;
  });
  const trenMingguan = hariKerjaPeriode.map((h) => trenMap[h.ds]);

  // --- 2) RANKING GURU PALING SERING TELAT/ALPA (periode payroll berjalan) ---
  const rankMap = {};
  rowsPeriode.forEach((r) => {
    const st = String(r.status).trim();
    if (st !== 'Terlambat' && st !== 'Tanpa Keterangan') return;
    const nuptk = String(r.nuptk).trim();
    if (!rankMap[nuptk]) rankMap[nuptk] = { nuptk, nama: r.nama || nuptk, terlambat: 0, alpa: 0 };
    if (st === 'Terlambat') rankMap[nuptk].terlambat++; else rankMap[nuptk].alpa++;
  });
  const rankingTelatAlpa = Object.values(rankMap)
    .map((r) => ({ ...r, total: r.terlambat + r.alpa }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

  // --- 3) DISTRIBUSI JAM DATANG (bucket 30 menit) - dari jam masuk NYATA saja
  // (status Hadir/Terlambat, bukan Sakit/Izin/dst yang jam-nya bukan representasi
  // jam datang fisik), diambil dari periode payroll berjalan biar datanya cukup banyak.
  const bucketJam = {};
  rowsPeriode.forEach((r) => {
    const st = String(r.status).trim();
    if (st !== 'Hadir' && st !== 'Terlambat') return;
    const m = String(r.jam || '').trim().match(/^(\d{2}):(\d{2})/);
    if (!m) return;
    const menitBucket = parseInt(m[2], 10) < 30 ? '00' : '30';
    const label = m[1] + ':' + menitBucket;
    bucketJam[label] = (bucketJam[label] || 0) + 1;
  });
  const distribusiJam = Object.keys(bucketJam).sort().map((label) => ({ label, jumlah: bucketJam[label] }));

  // --- 4) KEPATUHAN KEGIATAN RUTIN (Briefing & Tawasul/Dzuhur/Ashar), periode berjalan ---
  // Dhuha SENGAJA tidak dipakai di sini - jadwalnya beda-beda per guru (bukan
  // satu waktu bersama seperti sholat), jadi tidak relevan dijadikan metrik
  // kepatuhan bersama. Briefing & Tawasul dipakai sebagai gantinya karena
  // sifatnya wajib sama seperti Dzuhur/Ashar - datanya diambil dari
  // kegiatan_umum jenis BRIEFING_TAWASUL, yang otomatis tercatat saat guru
  // pilih "Hadir & Tawasul" di Absen Masuk (lihat saveAbsenMasuk, ikutTawasul).
  //
  // Penyebutnya SENGAJA seluruh staf aktif x hari kerja periode (bukan cuma
  // yang lapor) - guru yang tidak pernah lapor sama sekali (mis. lupa) HARUS
  // ikut menurunkan persentase, bukan hilang begitu saja. Query di atas sudah
  // menyaring status yang dihitung, jadi cukup menghitung jumlah barisnya.
  const penyebutKepatuhan = Math.max(1, totalStafAktif * hariKerjaPeriode.length);
  const kepatuhanKegiatan = JENIS_KEGIATAN_RUTIN.map((j, i) => ({
    label: j.label,
    persen: Math.min(100, Math.round((rowsKegiatanPerJenis[i].length / penyebutKepatuhan) * 100))
  }));

  return { trenMingguan, rankingTelatAlpa, distribusiJam, kepatuhanKegiatan };
}

// ====================================================================
// SETTINGS
// ====================================================================

// ====================================================================
// ATURAN PENILAIAN (skor kinerja guru) - GLOBAL, sama untuk semua sekolah.
// Disimpan di Cloudflare KV (env.SESSIONS, namespace yang sama dipakai untuk
// sesi login & cache lain) sebagai satu JSON, BUKAN di tabel 'settings' -
// sengaja begitu supaya tidak bergantung sama sekali pada asumsi skema tabel
// 'settings' (mis. kemungkinan ada foreign key sekolah_id -> tabel sekolah,
// yang akan gagal kalau diisi ID palsu untuk mewakili "global"). KV tidak
// punya batasan relasional apapun, cocok untuk data lintas-sekolah begini,
// dan TIDAK diberi expirationTtl - tersimpan permanen sampai ditimpa lagi.
// HANYA Admin Utama yang boleh baca/ubah - supaya aturan skor memang
// konsisten di semua sekolah, tidak bisa disetel beda-beda sendiri per sekolah.
// ====================================================================
const KV_KEY_ATURAN_PENILAIAN = 'ATURAN_PENILAIAN_GLOBAL';

const DEFAULT_ATURAN_PENILAIAN = {
  bobot_terlambat_kehadiran: '0.8',
  bobot_alpa_kehadiran: '0',
  bobot_sakit: '0.9',
  bobot_izin: '0.7',
  bobot_terlambat_jp: '0.5',
  bobot_alpa_jp: '1',
  bonus_per_impal: '0.5',
  maks_bonus_impal: '10',
  predikat_sangat_baik: '90',
  predikat_baik: '80',
  predikat_cukup: '70'
};

/**
 * Baca Aturan Penilaian TANPA cek role - dipakai INTERNAL oleh fungsi lain
 * yang perlu bobot-bobotnya untuk menghitung skor (mis. getNilaiGuru), yang
 * aksesnya harus semewah getPayrollReport (Admin/Piket/Kepsek), BUKAN
 * dibatasi ADMIN_UTAMA saja seperti halaman pengaturannya sendiri. Jangan
 * diekspos langsung ke frontend - untuk itu pakai getAturanPenilaian().
 */
async function bacaAturanPenilaianInternal(env) {
  const raw = await env.SESSIONS.get(KV_KEY_ATURAN_PENILAIAN);
  const tersimpan = raw ? JSON.parse(raw) : {};
  return { ...DEFAULT_ATURAN_PENILAIAN, ...tersimpan };
}

async function getAturanPenilaian(args, env) {
  const [token] = args;
  const user = await requireUser(env, token);
  if (!isRole(user, 'ADMIN_UTAMA')) return {};
  return bacaAturanPenilaianInternal(env);
}

async function saveAturanPenilaian(args, env) {
  const [token, config] = args;
  const user = await requireUser(env, token);
  if (!isRole(user, 'ADMIN_UTAMA')) return { success: false, message: 'Akses ditolak - aturan penilaian cuma bisa diubah Admin Utama.' };

  const raw = await env.SESSIONS.get(KV_KEY_ATURAN_PENILAIAN);
  const tersimpan = raw ? JSON.parse(raw) : {};
  const gabungan = { ...DEFAULT_ATURAN_PENILAIAN, ...tersimpan };
  for (const key of Object.keys(config)) {
    if (config[key] !== undefined) gabungan[key] = String(config[key]);
  }
  await env.SESSIONS.put(KV_KEY_ATURAN_PENILAIAN, JSON.stringify(gabungan));
  return { success: true, message: 'Aturan Penilaian berhasil disimpan, berlaku untuk semua sekolah.' };
}

async function getSettingsData(args, env) {
  const [token, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user) && !isRole(user, 'PIKET')) return {};
  const sekolahId = resolveSekolahId(user, requestedSekolahId);
  return getSettingsMap(env, sekolahId);
}

/**
 * Versi MINIMAL dari getSettingsData(), cuma 3 field identitas untuk kop surat
 * cetak (nama sekolah, alamat, nama wakasek) - dibuat TERPISAH dan boleh
 * diakses SIAPA PUN yang login (bukan cuma Admin/Piket seperti
 * getSettingsData()), karena dipakai fitur cetak Rekap Kehadiran milik sendiri
 * yang berlaku untuk semua role. Sengaja TIDAK ikut mengembalikan field
 * sensitif lain di settings (koordinat GPS, radius, dll) - guru biasa tidak
 * perlu dan tidak semestinya bisa melihat itu.
 */
async function getIdentitasSekolahUntukCetak(args, env) {
  const [token] = args;
  const user = await requireUser(env, token);
  if (!user) return {};
  const settings = await getSettingsMap(env, user.sekolahId);
  return {
    nama_sekolah: settings.nama_sekolah || '',
    alamat_sekolah: settings.alamat_sekolah || '',
    nama_wakasek: settings.nama_wakasek || '',
    kop_baris1: settings.kop_baris1 || '',
    kop_baris2: settings.kop_baris2 || '',
    logo_kiri_url: settings.logo_kiri_url || '',
    logo_kanan_url: settings.logo_kanan_url || '',
    ttd_wakasek_url: settings.ttd_wakasek_url || ''
  };
}

/**
 * Upload gambar identitas sekolah (JPG/PNG) ke Google Drive: logo kiri/kanan
 * kop surat DAN tanda tangan digital Wakasek (jenis 'kiri' | 'kanan' | 'ttd').
 * Berjalan ATAS NAMA akun
 * Google pribadi pemilik aplikasi (refresh_token, lihat drive.js &
 * googleAuth.js), BUKAN akun admin sekolah yang sedang mengupload. Admin
 * sekolah cukup pilih file, tidak perlu login/pilih akun Google apa pun -
 * sepenuhnya di balik layar. URL hasilnya langsung tersimpan ke settings
 * sekolah (key logo_kiri_url/logo_kanan_url) - admin tidak perlu klik
 * "Simpan Pengaturan" terpisah setelah upload.
 */
async function uploadGambarIdentitas(args, env) {
  const [token, jenis, base64Data, mimeType, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user)) return { success: false, message: 'Akses ditolak.' };
  const sekolahId = resolveSekolahId(user, requestedSekolahId);

  const jenisBersih = String(jenis || '').trim().toLowerCase();
  if (!['kiri', 'kanan', 'ttd'].includes(jenisBersih)) {
    return { success: false, message: 'Jenis gambar tidak valid (harus "kiri", "kanan", atau "ttd").' };
  }
  if (!driveSudahDisetup(env)) {
    return { success: false, message: 'Setup Google Drive belum lengkap di Worker Secrets (DRIVE_SCRIPT_URL/DRIVE_SCRIPT_KEY, atau DRIVE_OWNER_REFRESH_TOKEN/CLIENT_ID/CLIENT_SECRET) - lihat README bagian "Setup Kop Surat".' };
  }
  const mimeBersih = String(mimeType || '').trim().toLowerCase();
  if (!/^image\/(png|jpe?g)$/.test(mimeBersih)) {
    return { success: false, message: 'Format file harus JPG atau PNG.' };
  }
  if (!base64Data || base64Data.length > 7000000) { // ~5MB file asli (base64 lebih besar ~1.37x dari ukuran biner)
    return { success: false, message: 'File kosong atau terlalu besar (maksimal sekitar 5MB).' };
  }

  const ekstensi = mimeBersih === 'image/png' ? 'png' : 'jpg';
  const namaFile = jenisBersih === 'ttd'
    ? `ttd-wakasek-${sekolahId}.${ekstensi}`
    : `logo-${jenisBersih}-${sekolahId}.${ekstensi}`;
  const keySettings = jenisBersih === 'ttd' ? 'ttd_wakasek_url' : `logo_${jenisBersih}_url`;

  let hasil;
  try {
    hasil = await uploadFileKeDrive(env, base64Data, mimeBersih, namaFile);
  } catch (err) {
    return { success: false, message: 'Gagal upload ke Google Drive: ' + err.message };
  }

  const existingRows = await sbSelect(env, 'settings', `sekolah_id=eq.${sekolahId}&key=eq.${keySettings}&limit=1`);
  const urlLama = existingRows.length > 0 ? existingRows[0].value : null;
  if (existingRows.length > 0) {
    await sbUpdateWhere(env, 'settings', { sekolah_id: sekolahId, key: keySettings }, { value: hasil.url });
  } else {
    await sbInsert(env, 'settings', { sekolah_id: sekolahId, key: keySettings, value: hasil.url });
  }
  await invalidate(env, `SETTINGS_CACHE_${sekolahId}`);

  // Gambar lama dihapus dari Drive SETELAH yang baru tersimpan (best effort - gagal
  // menghapus tidak membatalkan upload), supaya file lama yang berlink publik tidak
  // menumpuk setiap kali gambar diganti.
  if (urlLama) await hapusFileDriveDariUrl(env, urlLama);

  return { success: true, url: hasil.url, message: `${jenisBersih === 'ttd' ? 'Tanda tangan digital' : 'Logo ' + jenisBersih} berhasil diupload dan disimpan.` };
}

async function saveSettingsData(args, env) {
  const [token, config, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user)) return false;
  const sekolahId = resolveSekolahId(user, requestedSekolahId);

  // Dulu tiap key pengaturan (bisa belasan sekaligus - jam masuk, lokasi,
  // identitas kop, dst) diproses SATU-SATU secara berurutan: SELECT dulu
  // (cek sudah ada atau belum), baru UPDATE/INSERT - total bisa puluhan
  // round-trip berurutan ke Supabase untuk satu kali klik "Simpan", itu
  // sebabnya terasa lama. Sekarang semuanya dikirim jadi SATU request upsert
  // (lihat sbUpsertMany di supabase.js) - primary key gabungan (sekolah_id,
  // key) yang sudah ada di tabel settings dipakai Postgres untuk otomatis
  // tahu mana yang perlu di-update vs di-insert baru, dalam 1 query saja.
  const rows = Object.keys(config)
    .filter((key) => config[key] !== undefined)
    .map((key) => ({ sekolah_id: sekolahId, key, value: String(config[key]) }));

  if (rows.length) {
    await sbUpsertMany(env, 'settings', rows, 'sekolah_id,key');
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
  return result.map((u) => ({ id: u.legacy_id, nuptk: u.nuptk, nama: u.nama, email: u.email, role: u.role, status: u.status, kategori: u.kategori || 'Mengajar', kewajibanMengajarJp: u.kewajiban_mengajar_jp || null }));
}

async function saveUser(args, env) {
  const [token, userData] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user)) return { success: false, message: 'Akses ditolak.' };

  // Cuma Admin Utama yang boleh bikin akun ADMIN_SEKOLAH baru.
  if (userData.role === 'ADMIN_SEKOLAH' && user.role !== 'ADMIN_UTAMA') {
    return { success: false, message: 'Akses ditolak. Hanya Admin Utama yang bisa membuat akun Admin Sekolah.' };
  }
  if (userData.role === 'ADMIN_UTAMA') return { success: false, message: 'Akses ditolak.' }; // tidak ada UI untuk ini, sengaja diblokir dari sisi backend juga

  // Admin Sekolah: user baru otomatis masuk sekolahnya sendiri.
  // Admin Utama: WAJIB sertakan userData.sekolahId (pilih dari dropdown sekolah di form).
  let sekolahId;
  if (user.role === 'ADMIN_UTAMA') {
    if (!userData.sekolahId) return { success: false, message: 'Pilih sekolah dulu sebelum menambah akun.' };
    sekolahId = userData.sekolahId;
  } else {
    sekolahId = user.sekolahId;
  }

  const nuptk = String(userData.nuptk).trim();
  if (!nuptk) return { success: false, message: 'NUPTK/Username tidak boleh kosong.' };

  try {
    await sbInsert(env, 'users', {
      nuptk, sekolah_id: sekolahId, legacy_id: generateShortID('U'), nama: userData.nama, email: userData.email,
      password: userData.password, role: userData.role, status: 'Aktif',
      created_at: new Date().toISOString(), kategori: userData.kategori || 'Mengajar',
      kewajiban_mengajar_jp: userData.kewajibanMengajarJp ? parseInt(userData.kewajibanMengajarJp, 10) : null
    });
  } catch (err) {
    // NUPTK/Username adalah primary key GLOBAL (dipakai bersama di semua sekolah,
    // sesuai kesepakatan awal multi-tenant) - jadi tabrakan bisa terjadi walau
    // guru yang namanya sama itu ada di SEKOLAH LAIN, bukan cuma di sekolah sendiri.
    // Duplicate key dari Postgres/PostgREST selalu mengandung teks ini di pesannya.
    if (String(err.message).includes('duplicate key')) {
      return { success: false, message: `NUPTK/Username "${nuptk}" sudah dipakai (kemungkinan oleh guru di sekolah lain, karena NUPTK/Username harus unik di seluruh sistem). Gunakan NUPTK/Username lain, misalnya tambahkan inisial sekolah di belakangnya.` };
    }
    throw err; // error lain yang tak terduga tetap dilempar apa adanya, biar kelihatan di log
  }

  await invalidate(env, `USERS_CACHE_${sekolahId}`);
  return { success: true, message: 'Akun baru berhasil ditambahkan.' };
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
    status: userData.status, kategori: userData.kategori || 'Mengajar',
    kewajiban_mengajar_jp: userData.kewajibanMengajarJp ? parseInt(userData.kewajibanMengajarJp, 10) : null
  };
  // Password cuma diupdate kalau memang diisi ulang (kolom dikosongkan di form = tidak diubah).
  if (userData.password && String(userData.password).trim() !== '') {
    dataUpdate.password = String(userData.password).trim();
  }

  await sbUpdate(env, 'users', 'nuptk', String(nuptkTarget).trim(), dataUpdate);
  await invalidate(env, `USERS_CACHE_${target.sekolah_id}`);
  return { success: true, message: `Data ${target.nama} berhasil diperbarui.` };
}

/**
 * Ganti NUPTK/Username akun TANPA kehilangan data historis.
 *
 * nuptk dipakai sebagai primary key tabel 'users' DAN sebagai penanda
 * kepemilikan data di HAMPIR SEMUA tabel lain: absen_masuk, kegiatan_umum,
 * absen_kegiatan_khusus, cuti_guru, rekap_jam_pelajaran (termasuk kolom
 * nuptk_impal - baris di mana guru ini jadi GURU PENGGANTI, bukan guru
 * utamanya). Kalau nuptk cuma diganti di tabel 'users' saja, semua riwayat
 * lama itu jadi "yatim" - tetap ada di database, tapi tidak akan pernah
 * muncul lagi di Rekap/Laporan/Payroll/Riwayat Aktivitas guru ybs (semuanya
 * query berdasarkan nuptk sesi login, yaitu nuptk yang BARU).
 *
 * Karena tidak diketahui pasti apakah tabel-tabel ini punya FOREIGN KEY
 * constraint sungguhan ke users.nuptk di level Postgres (arsitektur app ini
 * menjoin manual lewat kode, bukan lewat FK relasional), urutan di bawah
 * SENGAJA dibuat aman untuk KEDUA kemungkinan (ada FK maupun tidak):
 *   1. INSERT dulu baris users BARU (salinan persis baris lama, cuma nuptk-
 *      nya diganti) - supaya nuptk lama MAUPUN nuptk baru sama-sama valid/
 *      ada di tabel users selama proses migrasi berlangsung (tidak pernah
 *      ada momen salah satunya "tidak ada" - andai ada FK constraint,
 *      langkah 2 di bawah tidak akan pernah ditolak karena user tujuannya
 *      belum ada).
 *   2. Migrasikan seluruh tabel riwayat dari nuptk lama -> nuptk baru.
 *   3. Baru TERAKHIR, hapus baris users yang lama.
 * Kalau di tengah proses ada yang gagal (mis. koneksi ke Supabase putus),
 * akun TETAP BISA dipakai login dengan username LAMA (baris lama belum
 * sempat dihapus) - tidak pernah ada momen akun "hilang" total. Aman
 * dijalankan ulang (idempotent): baris yang sudah kepindah nuptk-nya tidak
 * akan ketemu lagi oleh filter nuptk lama di percobaan berikutnya, jadi
 * cuma sisa yang belum sempat pindah yang diproses ulang.
 *
 * CATATAN: kalau guru ybs SEDANG LOGIN (sesi aktif tersimpan di Workers KV)
 * saat username-nya diganti, sesi itu masih menyimpan nuptk LAMA sampai dia
 * logout & login ulang - sebaiknya minta guru itu logout dulu sebelum
 * username-nya diganti, atau logout ulang sesudahnya.
 */
async function changeUsername(args, env) {
  const [token, nuptkLama, nuptkBaruRaw] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user)) return { success: false, message: 'Akses ditolak.' };

  const lama = String(nuptkLama || '').trim();
  const baru = String(nuptkBaruRaw || '').trim();
  if (!lama || !baru) return { success: false, message: 'Username lama/baru tidak boleh kosong.' };
  if (lama === baru) return { success: false, message: 'Username baru sama dengan yang lama.' };

  const rowsLama = await sbSelect(env, 'users', `nuptk=eq.${encodeURIComponent(lama)}&limit=1`);
  const target = rowsLama[0];
  if (!target) return { success: false, message: 'Akun dengan username tersebut tidak ditemukan.' };
  if (user.role !== 'ADMIN_UTAMA' && target.sekolah_id !== user.sekolahId) {
    return { success: false, message: 'Akses ditolak. Akun ini bukan dari sekolah Anda.' };
  }

  const rowsBaru = await sbSelect(env, 'users', `nuptk=eq.${encodeURIComponent(baru)}&limit=1`);
  if (rowsBaru[0]) {
    return { success: false, message: `Username "${baru}" sudah dipakai akun lain (NUPTK/Username unik di seluruh sistem, lintas sekolah).` };
  }

  // Langkah 1: salin baris users ke nuptk baru (baris lama TETAP ADA dulu).
  const salinan = { ...target, nuptk: baru };
  delete salinan.id; // jaga-jaga kalau ada kolom id auto-generate terpisah dari nuptk - biarkan Supabase generate ulang, jangan dobel PK
  await sbInsert(env, 'users', salinan);

  // Langkah 2: migrasikan riwayat di semua tabel yang menyimpan nuptk guru ini.
  const TABEL_RIWAYAT_NUPTK = ['absen_masuk', 'kegiatan_umum', 'absen_kegiatan_khusus', 'cuti_guru', 'rekap_jam_pelajaran', 'rapor_nilai'];
  const gagal = [];
  for (const tabel of TABEL_RIWAYAT_NUPTK) {
    try {
      await sbUpdate(env, tabel, 'nuptk', lama, { nuptk: baru });
    } catch (err) {
      // rapor_nilai baru ada setelah fitur Rapor GTK dipasang - kalau tabelnya belum ada, abaikan.
      if (tabel === 'rapor_nilai' && /PGRST205|does not exist|Could not find the table/i.test(err.message)) continue;
      gagal.push(`${tabel}: ${err.message}`);
    }
  }
  try {
    // Kolom terpisah khusus rekap_jam_pelajaran - baris di mana guru ini
    // tercatat sebagai GURU PENGGANTI (impal), bukan guru utama barisnya.
    await sbUpdate(env, 'rekap_jam_pelajaran', 'nuptk_impal', lama, { nuptk_impal: baru });
  } catch (err) {
    gagal.push(`rekap_jam_pelajaran (kolom guru pengganti): ${err.message}`);
  }

  if (gagal.length) {
    return {
      success: false,
      message: `Username BELUM sepenuhnya diganti - sebagian riwayat gagal dipindahkan: ${gagal.join('; ')}. `
        + `Username LAMA "${lama}" masih aktif dan bisa dipakai login seperti biasa (belum dihapus). `
        + `Coba jalankan ulang Ganti Username ini - bagian yang sudah berhasil pindah tidak akan diproses ulang.`
    };
  }

  // Langkah 3: sekarang aman, hapus baris users yang lama.
  await sbDelete(env, 'users', 'nuptk', lama);
  await invalidate(env, `USERS_CACHE_${target.sekolah_id}`);

  return {
    success: true,
    message: `Username berhasil diganti dari "${lama}" menjadi "${baru}". Seluruh riwayat absen, kegiatan, cuti, dan rekap jam pelajaran tetap utuh dan sudah ikut dipindahkan. Kalau guru ybs sedang login, minta dia logout lalu login ulang pakai username baru.`
  };
}

/**
 * Hapus gambar identitas (logo kiri/kanan atau tanda tangan digital) yang sudah
 * diupload: file di Google Drive dihapus, lalu pengaturannya dikosongkan sehingga
 * Cetak PDF berikutnya kembali tanpa gambar itu. Kalau penghapusan di Drive gagal
 * (mis. izin/token bermasalah), pengaturan TETAP dikosongkan (gambar berhenti
 * dipakai di cetakan) tapi pesan peringatan dikirim - file-nya mungkin masih ada
 * di Drive dan perlu dihapus manual.
 */
async function hapusGambarIdentitas(args, env) {
  const [token, jenis, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user)) return { success: false, message: 'Akses ditolak.' };
  const sekolahId = resolveSekolahId(user, requestedSekolahId);

  const jenisBersih = String(jenis || '').trim().toLowerCase();
  if (!['kiri', 'kanan', 'ttd'].includes(jenisBersih)) {
    return { success: false, message: 'Jenis gambar tidak valid (harus "kiri", "kanan", atau "ttd").' };
  }
  const keySettings = jenisBersih === 'ttd' ? 'ttd_wakasek_url' : `logo_${jenisBersih}_url`;
  const namaTampil = jenisBersih === 'ttd' ? 'Tanda tangan digital' : `Logo ${jenisBersih}`;

  const rows = await sbSelect(env, 'settings', `sekolah_id=eq.${sekolahId}&key=eq.${keySettings}&limit=1`);
  const urlLama = rows.length > 0 ? rows[0].value : '';
  if (!urlLama) return { success: true, message: `${namaTampil} memang belum ada.` };

  let hasilDrive = { ok: true };
  if (driveSudahDisetup(env)) {
    hasilDrive = await hapusFileDriveDariUrl(env, urlLama);
  } else {
    hasilDrive = { ok: false, pesan: 'Setup Google Drive belum lengkap di Worker Secrets.' };
  }

  await sbUpdateWhere(env, 'settings', { sekolah_id: sekolahId, key: keySettings }, { value: '' });
  await invalidate(env, `SETTINGS_CACHE_${sekolahId}`);

  if (!hasilDrive.ok) {
    return {
      success: true, peringatan: true,
      message: `${namaTampil} sudah tidak dipakai lagi di cetakan, tapi file-nya mungkin masih ada di Google Drive (${hasilDrive.pesan}). Hapus manual dari folder "AbsenYuk - Kop Surat" kalau perlu.`
    };
  }
  return { success: true, message: `${namaTampil} berhasil dihapus.` };
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

// Label ramah-baca untuk jenis_kegiatan di kegiatan_umum, dipakai khusus di
// Riwayat Aktivitas (bukan Laporan - Laporan sudah pakai label dari REPORT_CONFIG).
const LABEL_KEGIATAN_RIWAYAT = {
  BRIEFING_TAWASUL: 'Briefing & Tawasul',
  PENDAMPINGAN_DHUHA: 'Pendampingan Dhuha',
  SHOLAT_DZUHUR: 'Sholat Dzuhur',
  SHOLAT_ASHAR: 'Sholat Ashar',
  DZIKIR_MAKHSUS: 'Dzikir Makhsus',
  PENGAJIAN_AHAD: 'Pengajian Ahad',
  PENGAJIAN_ARBAIN: 'Pengajian Arbain',
  QINI_NASIONAL_SUBUH: 'Qini Nasional - Subuh',
  QINI_NASIONAL_MALAM: 'Qini Nasional - Malam'
};

/**
 * Riwayat Aktivitas: gabungan Absen Masuk + Kegiatan Sekolah/Pesantren
 * (kegiatan_umum) + Kegiatan Khusus jadi SATU daftar kronologis (terbaru dulu).
 * Cakupan otomatis mengikuti role LOGIN, bukan dari parameter yang dikirim client -
 * supaya tidak bisa "diakali" client untuk lihat data yang bukan haknya:
 *   - GURU biasa       : cuma aktivitas dirinya sendiri.
 *   - PIKET/KEPSEK/ADMIN_SEKOLAH : seluruh aktivitas sekolahnya sendiri.
 *   - ADMIN_UTAMA       : requestedSekolahId diisi -> sekolah itu saja;
 *                         requestedSekolahId kosong -> SEMUA sekolah sekaligus
 *                         (dipakai sebagai tampilan awal setelah login, sebelum
 *                         admin utama sempat pilih sekolah aktif).
 */
async function getRiwayatAktivitas(args, env) {
  const [token, requestedSekolahId, limitArg] = args;
  const user = await requireUser(env, token);
  if (!user) return [];

  const limit = Math.min(parseInt(limitArg, 10) || 50, 100);

  let filterSekolah = '';
  let filterNuptk = '';
  if (user.role === 'ADMIN_UTAMA') {
    if (requestedSekolahId) filterSekolah = `sekolah_id=eq.${encodeURIComponent(requestedSekolahId)}&`;
    // kalau kosong: sengaja TANPA filter sekolah sama sekali (lihat semua sekolah)
  } else if (isAdminAny(user) || isRole(user, 'PIKET', 'KEPALA_SEKOLAH')) {
    filterSekolah = `sekolah_id=eq.${encodeURIComponent(user.sekolahId)}&`;
  } else {
    filterSekolah = `sekolah_id=eq.${encodeURIComponent(user.sekolahId)}&`;
    filterNuptk = `nuptk=eq.${encodeURIComponent(user.nuptk)}&`;
  }

  // Ambil lebih banyak dari tiap sumber daripada limit final - supaya setelah
  // digabung+diurutkan ulang lintas 3 tabel, tetap ada cukup data terbaru dari
  // masing-masing sumber (bukan keburu kepotong duluan sebelum digabung).
  const ambil = limit;

  const perluDaftarSekolah = user.role === 'ADMIN_UTAMA' && !requestedSekolahId;
  // Kecualikan baris HASIL BACKFILL saveCutiGuru() saja (bukan semua baris
  // berstatus Cuti/Sakit) - dikenali lewat awalan ID-nya sendiri: 'AC_' untuk
  // absen_masuk, 'KC_' untuk kegiatan_umum (lihat generateShortID() dipakai
  // di saveCutiGuru()). Cuti panjang (mis. melahirkan, bisa 3 bulan) membuat
  // puluhan/ratusan baris bertanggal JAUH ke depan yang kalau ikut diurutkan
  // tanggal.desc akan selalu nangkring di atas dan menenggelamkan aktivitas
  // guru lain hari ini.
  //
  // SENGAJA difilter lewat awalan ID, BUKAN lewat status='Cuti'/'Sakit' -
  // guru tetap bisa genuinely lapor 'Sakit' sendiri (Absen Masuk maupun
  // presensi Sholat), dan baris-baris itu ID-nya berawalan 'AB_'/'K_' (bukan
  // hasil backfill) sehingga TETAP HARUS muncul di Riwayat Aktivitas. Kalau
  // difilter lewat status, laporan sakit asli guru akan ikut tersembunyi
  // tanpa disadari - persis kekhawatiran yang perlu dihindari di sini.
  // Laporan & Payroll TIDAK terdampak sama sekali - filter ini cuma berlaku
  // di tampilan Riwayat Aktivitas.
  const kecualikanBackfillAbsenMasuk = 'id=not.like.AC*&';
  const kecualikanBackfillKegiatan = 'id=not.like.KC*&';
  const [rowsAbsenMasuk, rowsKegiatan, rowsKhusus, daftarSekolah] = await Promise.all([
    sbSelect(env, 'absen_masuk', `${filterSekolah}${filterNuptk}${kecualikanBackfillAbsenMasuk}order=tanggal.desc,jam.desc&limit=${ambil}`),
    sbSelect(env, 'kegiatan_umum', `${filterSekolah}${filterNuptk}${kecualikanBackfillKegiatan}order=tanggal.desc,timestamp.desc&limit=${ambil}`),
    sbSelect(env, 'absen_kegiatan_khusus', `${filterSekolah}${filterNuptk}order=tanggal_lapor.desc,waktu_lapor.desc&limit=${ambil}`),
    perluDaftarSekolah ? sbSelect(env, 'sekolah', 'order=nama.asc') : Promise.resolve([])
  ]);

  const namaSekolahMap = {};
  daftarSekolah.forEach((s) => { namaSekolahMap[s.id] = s.nama; });

  /** Konversi timestamp ISO (UTC) ke jam WIB "HH:MM" - supaya format 'urut' konsisten
   *  dengan field 'jam'/'waktu_lapor' dari 2 sumber lain (yang memang disimpan WIB),
   *  jadi pengurutan gabungan lintas 3 sumber akurat, bukan cuma kebetulan benar. */
  const gabungan = [];
  rowsAbsenMasuk.forEach((r) => {
    const jam = r.jam || '00:00';
    gabungan.push({
      jenis: 'Absen Masuk', icon: 'bi-door-open-fill', warna: 'primary',
      tanggal: r.tanggal, jam,
      nuptk: r.nuptk, nama: r.nama, sekolahId: r.sekolah_id, sekolahNama: namaSekolahMap[r.sekolah_id] || '',
      status: r.status, keterangan: r.keterangan,
      urut: `${r.tanggal} ${jam}`
    });

    // Absen Pulang BELUM PERNAH punya entri Riwayat Aktivitas sendiri sebelum
    // ini - baris absen_masuk yang sama dipakai untuk masuk MAUPUN pulang
    // (1 baris per hari, kolom jam_pulang diisi belakangan lewat UPDATE, lihat
    // saveAbsenPulang()), jadi tanpa ini pulangnya guru tidak pernah muncul di
    // sini sama sekali. Dikecualikan kalau jam_pulang = '--:--' - itu bukan
    // aktivitas guru sungguhan, melainkan tanda "Tidak Absen Pulang" yang
    // ditandai OTOMATIS oleh cron (lihat prosesAutoTidakAbsenPulangSatuSekolah()).
    if (r.jam_pulang && r.jam_pulang !== '--:--') {
      gabungan.push({
        jenis: 'Absen Pulang', icon: 'bi-door-closed-fill', warna: 'info',
        tanggal: r.tanggal, jam: r.jam_pulang,
        nuptk: r.nuptk, nama: r.nama, sekolahId: r.sekolah_id, sekolahNama: namaSekolahMap[r.sekolah_id] || '',
        status: r.status, keterangan: r.keterangan,
        urut: `${r.tanggal} ${r.jam_pulang}`
      });
    }
  });
  rowsKegiatan.forEach((r) => {
    const jam = jamWibDariTimestamp(r.timestamp);
    gabungan.push({
      jenis: LABEL_KEGIATAN_RIWAYAT[r.jenis_kegiatan] || r.jenis_kegiatan, icon: 'bi-calendar-check-fill', warna: 'success',
      tanggal: r.tanggal, jam,
      nuptk: r.nuptk, nama: r.nama, sekolahId: r.sekolah_id, sekolahNama: namaSekolahMap[r.sekolah_id] || '',
      status: r.status, keterangan: r.catatan,
      urut: `${r.tanggal} ${jam}`
    });
  });
  rowsKhusus.forEach((r) => {
    const jam = r.waktu_lapor || '00:00';
    gabungan.push({
      jenis: r.nama_kegiatan || 'Kegiatan Khusus', icon: 'bi-ui-checks', warna: 'warning',
      tanggal: r.tanggal_lapor, jam,
      nuptk: r.nuptk, nama: r.nama, sekolahId: r.sekolah_id, sekolahNama: namaSekolahMap[r.sekolah_id] || '',
      status: r.status_kehadiran, keterangan: r.catatan,
      urut: `${r.tanggal_lapor} ${jam}`
    });
  });

  gabungan.sort((a, b) => (a.urut < b.urut ? 1 : a.urut > b.urut ? -1 : 0));
  return gabungan.slice(0, limit);
}

async function getGuruMengajarList(args, env) {
  const [token, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user) && !isRole(user, 'PIKET', 'KEPALA_SEKOLAH')) return [];
  const sekolahId = resolveSekolahId(user, requestedSekolahId);
  const result = await getUsersListCached(env, sekolahId);
  // ADMIN_UTAMA dikecualikan (bukan staf spesifik 1 sekolah), tapi ADMIN_SEKOLAH TETAP
  // disertakan kalau kategori-nya Mengajar - admin sekolah bisa saja juga punya jadwal
  // mengajar sendiri, jadi wajar muncul di daftar "guru tidak hadir" jam pelajaran.
  return result.filter((u) => (u.kategori || 'Mengajar') === 'Mengajar' && String(u.role).trim() !== 'ADMIN_UTAMA')
    .map((u) => ({ id: u.legacy_id, nuptk: u.nuptk, nama: u.nama, status: u.status, role: u.role, row: u.nuptk }));
}

// Baris yang dibuat OTOMATIS oleh sistem (bukan aktivitas guru). Dipakai deleteUser()
// untuk membedakan akun yang "benar-benar belum punya riwayat" dari akun yang cuma
// punya baris buatan cron/Tutup Absen. Penandanya SAMA dengan yang ditulis kodenya:
//  - absen_masuk: auto-alpa -> status 'Tanpa Keterangan' + keterangan 'Tidak Absen!'
//  - kegiatan_umum: auto Tidak Absen Sholat -> status 'Tidak Absen' + catatan 'Otomatis oleh sistem...'
//  - absen_kegiatan_khusus: Tutup Absen -> status_kehadiran 'Tanpa Keterangan' + catatan 'Tidak Absen (Absen Ditutup Admin)'
// Kalau teks penandanya suatu saat berubah, barisnya otomatis dianggap riwayat NYATA
// (aman: akun tidak terhapus, cuma ditawari Nonaktifkan).
const CATATAN_OTOMATIS_KEGIATAN_UMUM = 'Otomatis oleh sistem - tidak melakukan absen sampai batas waktu.';
const BARIS_OTOMATIS = {
  absen_masuk: {
    label: 'Absen Masuk', kolomTanggal: 'tanggal', select: 'tanggal,status,keterangan',
    filter: { status: 'Tanpa Keterangan', keterangan: 'Tidak Absen!' },
    cocok: (r) => r.status === 'Tanpa Keterangan' && r.keterangan === 'Tidak Absen!'
  },
  kegiatan_umum: {
    label: 'Kegiatan Rutin (Sholat/Tawasul)', kolomTanggal: 'tanggal', select: 'tanggal,status,catatan',
    filter: { status: 'Tidak Absen', catatan: CATATAN_OTOMATIS_KEGIATAN_UMUM },
    cocok: (r) => r.status === 'Tidak Absen' && r.catatan === CATATAN_OTOMATIS_KEGIATAN_UMUM
  },
  absen_kegiatan_khusus: {
    label: 'Kegiatan Khusus', kolomTanggal: 'tanggal_lapor', select: 'tanggal_lapor,status_kehadiran,catatan',
    filter: { status_kehadiran: 'Tanpa Keterangan', catatan: 'Tidak Absen (Absen Ditutup Admin)' },
    cocok: (r) => r.status_kehadiran === 'Tanpa Keterangan' && r.catatan === 'Tidak Absen (Absen Ditutup Admin)'
  }
};

/**
 * Hapus akun. Tiga kemungkinan, supaya laporan & payroll tidak pernah rusak:
 *  1) Akun sama sekali tidak punya data           -> langsung dihapus.
 *  2) Akun hanya punya baris OTOMATIS sistem       -> TIDAK dihapus dulu; minta konfirmasi
 *     (butuhKonfirmasiOtomatis). Dihapus beserta baris otomatisnya hanya kalau args[2] === true.
 *     Konfirmasi eksplisit dipakai karena guru yang memang pernah bertugas tapi tidak pernah
 *     absen juga hanya punya baris otomatis - itu catatan "Tanpa Keterangan" yang sah.
 *  3) Akun punya riwayat NYATA (absen sungguhan, cuti, rekap jam pelajaran, jadi guru impal)
 *     -> ditolak (punyaRiwayat) dengan rincian; frontend menawarkan Nonaktifkan (setStatusUser).
 */
async function deleteUser(args, env) {
  const [token, nuptkAtauRow, hapusDataOtomatis] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user)) return { success: false, message: 'Akses ditolak. Anda bukan Admin.' };

  const nuptk = String(nuptkAtauRow).trim();
  const rows = await sbSelect(env, 'users', `nuptk=eq.${encodeURIComponent(nuptk)}&limit=1`);
  const target = rows[0];
  if (!target) return { success: false, message: 'Pendidik tidak ditemukan.' };
  if (user.role !== 'ADMIN_UTAMA' && target.sekolah_id !== user.sekolahId) {
    return { success: false, message: 'Akses ditolak. Pendidik ini bukan dari sekolah Anda.' };
  }
  if (['ADMIN_SEKOLAH', 'ADMIN_UTAMA'].includes(target.role) && user.role !== 'ADMIN_UTAMA') {
    return { success: false, message: 'Akses ditolak. Hanya Admin Utama yang bisa menghapus akun Admin.' };
  }

  // --- Periksa semua tabel yang merujuk nuptk ini ---
  const q = encodeURIComponent(nuptk);
  const tabelOtomatis = Object.keys(BARIS_OTOMATIS);
  const [hasilOtomatis, cuti, rekapJp, rekapImpal, raporManual] = await Promise.all([
    Promise.all(tabelOtomatis.map((t) => sbSelect(env, t, `select=${BARIS_OTOMATIS[t].select}&nuptk=eq.${q}`))),
    sbSelect(env, 'cuti_guru', `select=nuptk&nuptk=eq.${q}`),
    sbSelect(env, 'rekap_jam_pelajaran', `select=nuptk&nuptk=eq.${q}`),
    sbSelect(env, 'rekap_jam_pelajaran', `select=nuptk&nuptk_impal=eq.${q}`),
    // Nilai rapor yang diisi manual oleh penilai = riwayat nyata (tabel rapor_nilai tanpa foreign key,
    // jadi harus dicek di sini). Dibungkus catch: kalau tabelnya belum dibuat, dianggap kosong.
    sbSelect(env, 'rapor_nilai', `select=nuptk&nuptk=eq.${q}&sumber=eq.MANUAL&status=neq.BELUM`).catch(() => [])
  ]);

  const rincianNyata = [];
  const jumlahOtomatis = {};
  let totalOtomatis = 0;
  const semuaTanggalOtomatis = [];
  tabelOtomatis.forEach((t, i) => {
    const cfg = BARIS_OTOMATIS[t];
    let nyata = 0, otomatis = 0;
    hasilOtomatis[i].forEach((r) => {
      if (cfg.cocok(r)) { otomatis++; if (r[cfg.kolomTanggal]) semuaTanggalOtomatis.push(String(r[cfg.kolomTanggal]).slice(0, 10)); }
      else nyata++;
    });
    if (nyata) rincianNyata.push({ label: cfg.label, jumlah: nyata });
    if (otomatis) { jumlahOtomatis[t] = otomatis; totalOtomatis += otomatis; }
  });
  if (cuti.length) rincianNyata.push({ label: 'Cuti / Sakit', jumlah: cuti.length });
  if (rekapJp.length) rincianNyata.push({ label: 'Rekap Jam Pelajaran', jumlah: rekapJp.length });
  if (rekapImpal.length) rincianNyata.push({ label: 'Tercatat sebagai Guru Pengganti (Impal)', jumlah: rekapImpal.length });
  if (raporManual.length) rincianNyata.push({ label: 'Nilai Rapor GTK', jumlah: raporManual.length });

  if (rincianNyata.length) {
    return {
      success: false, punyaRiwayat: true, nama: target.nama, statusSaatIni: target.status, rincian: rincianNyata,
      message: `Akun ${target.nama} punya riwayat sehingga tidak bisa dihapus (laporan & payroll akan rusak). Nonaktifkan saja.`
    };
  }

  if (totalOtomatis > 0 && hapusDataOtomatis !== true) {
    semuaTanggalOtomatis.sort();
    return {
      success: false, butuhKonfirmasiOtomatis: true, nama: target.nama, statusSaatIni: target.status,
      jumlahOtomatis: totalOtomatis,
      tanggalAwal: semuaTanggalOtomatis[0] || '', tanggalAkhir: semuaTanggalOtomatis[semuaTanggalOtomatis.length - 1] || '',
      message: `Akun ${target.nama} hanya punya ${totalOtomatis} baris otomatis sistem. Perlu konfirmasi untuk menghapus.`
    };
  }

  // --- Boleh dihapus: bersihkan baris otomatis (kalau ada & sudah dikonfirmasi), lalu akunnya ---
  let terhapusOtomatis = 0;
  for (const t of Object.keys(jumlahOtomatis)) {
    terhapusOtomatis += await sbDeleteWhere(env, t, { nuptk, ...BARIS_OTOMATIS[t].filter });
  }
  // Sisa baris rapor otomatis/kosong milik akun ini ikut dibersihkan (tabel tanpa foreign key, tidak boleh jadi yatim).
  try { await sbDeleteWhere(env, 'rapor_nilai', { nuptk }); } catch (e) { /* tabel belum ada / tidak ada baris */ }
  try {
    await sbDelete(env, 'users', 'nuptk', nuptk);
  } catch (err) {
    // Jaring pengaman: masih ada tabel lain (yang tidak kita kenal) yang merujuk akun ini.
    if (/23503|foreign key/i.test(err.message)) {
      const m = err.message.match(/from table \\?"([^"\\]+)/);
      return {
        success: false, punyaRiwayat: true, nama: target.nama, statusSaatIni: target.status,
        rincian: [{ label: m ? `Data di tabel "${m[1]}"` : 'Data lain yang masih terkait', jumlah: 1 }],
        message: `Akun ${target.nama} masih dipakai data lain sehingga tidak bisa dihapus. Nonaktifkan saja.`
      };
    }
    throw err;
  }
  await invalidate(env, `USERS_CACHE_${target.sekolah_id}`);
  return {
    success: true,
    message: terhapusOtomatis > 0
      ? `Akun ${target.nama} dihapus beserta ${terhapusOtomatis} baris otomatis sistem.`
      : 'Data pendidik berhasil dihapus dari sistem.'
  };
}

/** Aktifkan / nonaktifkan akun tanpa menyentuh data lain (dipakai tombol "Nonaktifkan" saat akun tidak bisa dihapus). */
async function setStatusUser(args, env) {
  const [token, nuptkTarget, statusBaru] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user)) return { success: false, message: 'Akses ditolak.' };
  if (!['Aktif', 'Nonaktif'].includes(statusBaru)) return { success: false, message: 'Status tidak valid.' };

  const nuptk = String(nuptkTarget).trim();
  const rows = await sbSelect(env, 'users', `nuptk=eq.${encodeURIComponent(nuptk)}&limit=1`);
  const target = rows[0];
  if (!target) return { success: false, message: 'Pendidik tidak ditemukan.' };
  if (user.role !== 'ADMIN_UTAMA' && target.sekolah_id !== user.sekolahId) {
    return { success: false, message: 'Akses ditolak. Pendidik ini bukan dari sekolah Anda.' };
  }
  if (['ADMIN_SEKOLAH', 'ADMIN_UTAMA'].includes(target.role) && user.role !== 'ADMIN_UTAMA') {
    return { success: false, message: 'Akses ditolak. Hanya Admin Utama yang bisa mengubah status akun Admin.' };
  }
  if (statusBaru === 'Nonaktif' && String(user.nuptk).trim() === nuptk) {
    return { success: false, message: 'Anda tidak bisa menonaktifkan akun Anda sendiri.' };
  }

  await sbUpdate(env, 'users', 'nuptk', nuptk, { status: statusBaru });
  await invalidate(env, `USERS_CACHE_${target.sekolah_id}`);
  return { success: true, message: `Akun ${target.nama} sekarang ${statusBaru}.` };
}

async function getStafAktifUntukImpal(args, env) {
  const [token, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user) && !isRole(user, 'PIKET', 'KEPALA_SEKOLAH')) return [];
  const sekolahId = resolveSekolahId(user, requestedSekolahId);
  const users = await getUsersListCached(env, sekolahId);
  // Daftar impal/pengganti sengaja mencakup SEMUA staf aktif (mengajar maupun tidak
  // mengajar) - termasuk ADMIN_SEKOLAH, karena siapapun bisa diminta jadi pengganti
  // dadakan. Cuma ADMIN_UTAMA yang dikecualikan (bukan staf spesifik 1 sekolah).
  return users.filter((u) => String(u.status).trim() === 'Aktif' && String(u.role).trim() !== 'ADMIN_UTAMA')
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
// CUTI / SAKIT GURU (jangka panjang, input manual admin - bukan alur
// pengajuan+approval, cukup pencatatan) - selama rentang tanggal ini,
// guru ybs DIKECUALIKAN dari auto "Tanpa Keterangan" (Absen Masuk) dan
// auto "Tidak Absen" (Sholat Dzuhur/Ashar). Lihat pemakaiannya di
// getGuruCutiAktifHariIni(), dipanggil dari autoSetTanpaKeterangan() dan
// autoSetTidakAbsenSholat().
// ====================================================================

const STATUS_CUTI_VALID = ['Cuti', 'Sakit'];

async function getCutiGuruCached(env, sekolahId) {
  return cached(env, `CUTI_CACHE_${sekolahId}`, 300, () => sbSelect(env, 'cuti_guru', `sekolah_id=eq.${sekolahId}`));
}

/**
 * Return map { nuptk: 'Cuti'|'Sakit' } untuk guru yang rentang cutinya mencakup
 * tanggal target - dipakai fungsi otomasi untuk skip guru ybs, BUKAN untuk
 * ditampilkan di UI (untuk itu pakai getCutiList).
 */
async function getGuruCutiAktifHariIni(env, sekolahId, targetDateStr) {
  const daftarCuti = await getCutiGuruCached(env, sekolahId);
  const targetTime = new Date(targetDateStr).getTime();
  const map = {};
  daftarCuti.forEach((c) => {
    const startTime = new Date(c.tgl_mulai).getTime();
    const endTime = new Date(c.tgl_selesai).getTime();
    if (targetTime >= startTime && targetTime <= endTime) {
      map[String(c.nuptk).trim()] = c.status;
    }
  });
  return map;
}

async function saveCutiGuru(args, env) {
  const [token, nuptk, nama, tglMulai, tglSelesai, status, keterangan, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user)) return { success: false, message: 'Akses ditolak.' };
  const sekolahId = resolveSekolahId(user, requestedSekolahId);

  if (!nuptk) return { success: false, message: 'Guru wajib dipilih.' };
  if (!STATUS_CUTI_VALID.includes(status)) return { success: false, message: 'Status tidak dikenal: ' + status };
  if (new Date(tglMulai) > new Date(tglSelesai)) {
    return { success: false, message: 'Tanggal mulai tidak boleh melebihi tanggal selesai.' };
  }

  const id = generateShortID('C');
  await sbInsert(env, 'cuti_guru', {
    id, sekolah_id: sekolahId, nuptk, nama, tgl_mulai: tglMulai, tgl_selesai: tglSelesai,
    status, keterangan: keterangan || '-', created_at: new Date().toISOString()
  });
  await invalidate(env, `CUTI_CACHE_${sekolahId}`);

  // Backfill RETROAKTIF: supaya Laporan langsung menampilkan status Cuti/Sakit di
  // rentang ini (bukan cuma "dikecualikan diam-diam" dari auto-alpa ke depan), dan
  // supaya bisa mengakomodir cuti yang sudah berjalan SEBELUM dicatat di sini (mis.
  // sudah cuti 2 minggu sebelum pindah ke aplikasi ini - tinggal catat sekali dengan
  // tgl_mulai di masa lalu, sistem yang mengisi baris-baris hari kerja yang terlewat).
  // Cuma hari kerja (Senin-Jumat) & bukan hari libur sekolah yang diisi. Baris yang
  // SUDAH ADA dengan status kehadiran SUNGGUHAN (Hadir/Izin/dst) TIDAK ditimpa -
  // cuma baris 'Tanpa Keterangan' yang salah (guru sebenarnya cuti/sakit, bukan
  // alpa) yang dikoreksi jadi status yang benar.
  const ringkasanBackfill = { absenMasukDitambah: 0, absenMasukDikoreksi: 0, sholatDitambah: 0 };
  try {
    const settings = await getSettingsMap(env, sekolahId);
    const liburList = await getLiburListCached(env, sekolahId);
    const tanggalKerja = [];
    let cur = new Date(tglMulai + 'T00:00:00Z');
    const end = new Date(tglSelesai + 'T00:00:00Z');
    while (cur <= end) {
      const dow = cur.getUTCDay();
      const dTime = cur.getTime();
      const dstr = cur.toISOString().slice(0, 10);
      const isLibur = liburList.some((l) => dTime >= new Date(l.tgl_mulai).getTime() && dTime <= new Date(l.tgl_selesai).getTime());
      if (!isHariLiburMingguan(settings, dow) && !isLibur) tanggalKerja.push(dstr);
      cur.setUTCDate(cur.getUTCDate() + 1);
    }

    if (tanggalKerja.length > 0) {
      // --- Absen Masuk ---
      const existingAbsen = await sbSelect(env, 'absen_masuk',
        `sekolah_id=eq.${sekolahId}&nuptk=eq.${encodeURIComponent(nuptk)}&tanggal=gte.${tglMulai}&tanggal=lte.${tglSelesai}`);
      const existingAbsenMap = {};
      existingAbsen.forEach((r) => { existingAbsenMap[r.tanggal] = r; });

      const barisAbsenBaru = [];
      for (const tgl of tanggalKerja) {
        const existing = existingAbsenMap[tgl];
        if (!existing) {
          barisAbsenBaru.push({
            id: generateShortID('AC'), sekolah_id: sekolahId, tanggal: tgl, nuptk, nama,
            jam: '--:--', latitude: null, longitude: null, jarak: null,
            status, keterangan: keterangan || status, maps_link: '-'
          });
        } else if (existing.status === 'Tanpa Keterangan') {
          try {
            await sbUpdate(env, 'absen_masuk', 'id', existing.id, { status, keterangan: keterangan || status });
            ringkasanBackfill.absenMasukDikoreksi++;
          } catch (e) { /* tidak fatal, lanjutkan tanggal lain */ }
        }
      }
      if (barisAbsenBaru.length) {
        try {
          const hasil = await sbInsertMany(env, 'absen_masuk', barisAbsenBaru);
          ringkasanBackfill.absenMasukDitambah = hasil.length;
        } catch (e) {
          for (const b of barisAbsenBaru) {
            try { await sbInsert(env, 'absen_masuk', b); ringkasanBackfill.absenMasukDitambah++; } catch (e2) { /* skip */ }
          }
        }
      }
      await invalidate(env, `ABSEN_MASUK_PERIODE_CACHE_${sekolahId}`);

      // --- Sholat Dzuhur/Ashar (kalau wajib di sekolah ini) ---
      const jenisWajib = ['SHOLAT_DZUHUR', 'SHOLAT_ASHAR'].filter((j) => {
        const key = j === 'SHOLAT_DZUHUR' ? 'wajib_absen_dzuhur' : 'wajib_absen_ashar';
        return (settings[key] || 'Aktif') !== 'Nonaktif';
      });
      const barisSholatBaru = [];
      for (const jenis of jenisWajib) {
        const existingSholat = await sbSelect(env, 'kegiatan_umum',
          `sekolah_id=eq.${sekolahId}&nuptk=eq.${encodeURIComponent(nuptk)}&jenis_kegiatan=eq.${jenis}&tanggal=gte.${tglMulai}&tanggal=lte.${tglSelesai}`);
        const existingSet = new Set(existingSholat.map((r) => r.tanggal));
        for (const tgl of tanggalKerja) {
          if (!existingSet.has(tgl)) {
            barisSholatBaru.push({
              id: generateShortID('KC'), sekolah_id: sekolahId, jenis_kegiatan: jenis, tanggal: tgl,
              nuptk, nama, kegiatan: jenis, status, catatan: keterangan || status, timestamp: new Date().toISOString()
            });
          }
        }
      }
      if (barisSholatBaru.length) {
        try {
          const hasil = await sbInsertMany(env, 'kegiatan_umum', barisSholatBaru);
          ringkasanBackfill.sholatDitambah = hasil.length;
        } catch (e) {
          for (const b of barisSholatBaru) {
            try { await sbInsert(env, 'kegiatan_umum', b); ringkasanBackfill.sholatDitambah++; } catch (e2) { /* skip */ }
          }
        }
      }
    }
  } catch (err) {
    // Backfill gagal (mis. error jaringan ke Supabase) TIDAK membatalkan catatan
    // cuti_guru yang sudah tersimpan di atas - itu tetap jadi sumber kebenaran utama
    // untuk pengecualian auto-alpa ke depan, backfill cuma pelengkap tampilan laporan.
    console.error('[saveCutiGuru] Gagal backfill retroaktif:', err.message);
  }

  return {
    success: true,
    message: `${status} untuk ${nama} berhasil dicatat. `
      + `Absen Masuk: ${ringkasanBackfill.absenMasukDitambah} hari ditambahkan, ${ringkasanBackfill.absenMasukDikoreksi} dikoreksi dari Tanpa Keterangan. `
      + `Sholat: ${ringkasanBackfill.sholatDitambah} baris ditambahkan.`
  };
}

async function getCutiList(args, env) {
  const [token, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user) && !isRole(user, 'PIKET', 'KEPALA_SEKOLAH')) return [];
  const sekolahId = resolveSekolahId(user, requestedSekolahId);
  const result = await getCutiGuruCached(env, sekolahId);
  return result
    .sort((a, b) => (a.tgl_mulai < b.tgl_mulai ? 1 : -1)) // terbaru dulu
    .map((c) => ({
      id: c.id, nuptk: c.nuptk, nama: c.nama, tglMulai: c.tgl_mulai, tglSelesai: c.tgl_selesai,
      status: c.status, keterangan: c.keterangan, row: c.id
    }));
}

async function deleteCutiGuru(args, env) {
  const [token, idAtauRow] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user)) return { success: false, message: 'Akses ditolak.' };

  const rows = await sbSelect(env, 'cuti_guru', `id=eq.${encodeURIComponent(String(idAtauRow).trim())}&limit=1`);
  const target = rows[0];
  if (!target) return { success: false, message: 'Data cuti tidak ditemukan.' };
  if (user.role !== 'ADMIN_UTAMA' && target.sekolah_id !== user.sekolahId) {
    return { success: false, message: 'Akses ditolak. Data ini bukan milik sekolah Anda.' };
  }

  await sbDelete(env, 'cuti_guru', 'id', String(idAtauRow).trim());
  await invalidate(env, `CUTI_CACHE_${target.sekolah_id}`);
  return { success: true, message: 'Catatan cuti/sakit berhasil dihapus.' };
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
      payrollMap[u.nuptk] = { nuptk: u.nuptk, nama: u.nama, hadir: 0, terlambat: 0, sakit: 0, cuti: 0, izin: 0, tugasLuar: 0, alpa: 0 };
    }
  });

  const rows = await sbSelect(env, 'absen_masuk', `sekolah_id=eq.${sekolahId}&tanggal=gte.${sDateStr}&tanggal=lte.${eDateStr}`);
  // Dipakai jaring pengaman di bawah - tanggal mana saja yang SUDAH ada baris
  // (apa pun statusnya) per guru, supaya nanti tinggal dicek "tanggal kerja
  // mana yang TIDAK ada di sini sama sekali".
  const tanggalAdaBarisPerGuru = {};
  rows.forEach((row) => {
    const nuptk = String(row.nuptk).trim(), status = String(row.status).trim();
    if (payrollMap[nuptk]) {
      if (status === 'Hadir') payrollMap[nuptk].hadir++;
      else if (status === 'Terlambat') payrollMap[nuptk].terlambat++;
      // 'Cuti' digabung ke kolom sakit yang sama ("Sakit / Cuti") untuk
      // TAMPILAN (laporan payroll) - baris berstatus Cuti sudah otomatis
      // dibuatkan (backfill) oleh saveCutiGuru() untuk tiap hari kerja dalam
      // rentang yang didaftarkan admin, jadi cukup dibaca langsung dari sini,
      // TIDAK PERLU query ulang tabel cuti_guru secara terpisah. SEKALIGUS
      // dicatat murni di kolom 'cuti' terpisah (tidak ditampilkan di tabel
      // manapun, cuma dipakai getNilaiGuru() untuk membedakan Cuti - yang
      // dikecualikan total dari Skor Kehadiran - dari Sakit biasa, yang tetap
      // punya bobot sendiri).
      else if (status === 'Sakit') payrollMap[nuptk].sakit++;
      else if (status === 'Cuti') { payrollMap[nuptk].sakit++; payrollMap[nuptk].cuti++; }
      else if (status === 'Izin') payrollMap[nuptk].izin++;
      else if (status === 'Tugas Luar') payrollMap[nuptk].tugasLuar++;
      else if (status === 'Tanpa Keterangan') payrollMap[nuptk].alpa++;

      if (!tanggalAdaBarisPerGuru[nuptk]) tanggalAdaBarisPerGuru[nuptk] = new Set();
      tanggalAdaBarisPerGuru[nuptk].add(row.tanggal);
    }
  });

  // ====================================================================
  // JARING PENGAMAN: hari kerja yang TIDAK PUNYA BARIS SAMA SEKALI (bukan
  // cuma status kosong, tapi memang tidak pernah ter-backfill oleh cron/
  // trigger apa pun - mis. cron sempat gagal, atau Admin Sekolah sempat
  // menonaktifkan Auto Alpa lalu lupa mengaktifkan lagi) dihitung sebagai
  // Tanpa Keterangan TAMBAHAN di sini, murni saat laporan dibuat - TIDAK
  // menulis apa pun ke database. Supaya Admin tidak perlu buka database
  // manual tiap kali ada hari yang "terlewat" oleh mekanisme otomatis.
  //
  // Hari yang dihitung "kerja" = bukan hari libur mingguan sekolah ini,
  // bukan tanggal dalam rentang libur_nasional. Guru yang memang Cuti/Sakit
  // terdaftar TETAP AMAN - hari itu sudah pasti ada barisnya sendiri dari
  // backfill saveCutiGuru(), jadi tidak akan pernah dianggap "tidak ada
  // baris" di sini.
  //
  // KETERBATASAN yang disadari: tidak mengecek tanggal guru mulai bekerja
  // (data itu belum ada di sistem) - guru yang baru direkrut PERTENGAHAN
  // periode bisa saja ikut ketandai alpa untuk hari-hari SEBELUM dia
  // sungguhan mulai bekerja. Sama seperti auto-alfa cron yang sudah ada,
  // bukan keterbatasan baru dari fitur ini.
  const [settingsSekolah, liburSekolah] = await Promise.all([
    getSettingsMap(env, sekolahId),
    getLiburListCached(env, sekolahId)
  ]);
  const liburRanges = liburSekolah.map((l) => ({ start: new Date(l.tgl_mulai).getTime(), end: new Date(l.tgl_selesai).getTime() }));
  const isHariLiburSekolah = (waktuMs, dayOfWeek) => {
    if (isHariLiburMingguan(settingsSekolah, dayOfWeek)) return true;
    return liburRanges.some((r) => waktuMs >= r.start && waktuMs <= r.end);
  };

  const sMs = new Date(sDateStr).getTime();
  const eMs = new Date(eDateStr).getTime();
  for (let t = sMs; t <= eMs; t += 86400000) {
    const d = new Date(t);
    if (isHariLiburSekolah(t, d.getDay())) continue;
    const tanggalStr = toDateStr(d);
    Object.keys(payrollMap).forEach((nuptk) => {
      const sudahAda = tanggalAdaBarisPerGuru[nuptk] && tanggalAdaBarisPerGuru[nuptk].has(tanggalStr);
      if (!sudahAda) payrollMap[nuptk].alpa++;
    });
  }

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

  // Kegiatan Pesantren tidak diabsen semua guru dan TIDAK ada auto "Tidak Absen" (cron hanya
  // untuk Sholat). Supaya laporan lengkap: pada tanggal yang benar-benar ada acaranya (minimal
  // 20% staf aktif tercatat Hadir, aturan sama dengan Rapor GTK), staf aktif yang tidak punya
  // baris ditambahkan sebagai "Tidak Absen". Hanya tampilan laporan - tidak menulis ke database.
  if (JENIS_LAPORAN_PESANTREN.includes(config.jenisKegiatan)) {
    const users = (await getUsersListCached(env, sekolahId)).filter((u) =>
      ['GURU', 'KEPALA_SEKOLAH', 'PIKET', 'ADMIN_SEKOLAH'].includes(String(u.role).trim()) && String(u.status).trim() === 'Aktif');
    const hadirPerTgl = {}, adaPerTgl = {};
    rows.forEach((r) => {
      if (STATUS_PESANTREN_HADIR.includes(r.status)) hadirPerTgl[r.tanggal] = (hadirPerTgl[r.tanggal] || 0) + 1;
      (adaPerTgl[r.tanggal] = adaPerTgl[r.tanggal] || new Set()).add(String(r.nuptk).trim());
    });
    const ambang = Math.min(users.length || 1, Math.max(2, Math.ceil(users.length * 0.2)));
    for (const tgl of Object.keys(hadirPerTgl).filter((t) => hadirPerTgl[t] >= ambang)) {
      const cuti = await getGuruCutiAktifHariIni(env, sekolahId, tgl);
      users.forEach((u) => {
        const n = String(u.nuptk).trim();
        if (adaPerTgl[tgl].has(n) || cuti[n]) return;
        rows.push({
          id: '-', tanggal: tgl, nuptk: n, nama: String(u.nama).trim(), kegiatan: config.jenisKegiatan,
          status: 'Tidak Absen', catatan: 'Tidak melakukan absen pada kegiatan ini.', timestamp: ''
        });
      });
    }
  }

  const filterTarget = String(filterNuptk).trim();

  // Urutan Laporan Absen Masuk (KHUSUS jenis laporan ini) sekarang berdasarkan
  // STATUS (bukan murni kronologis lagi), supaya nyaman dibaca pimpinan:
  // Tugas Dinas -> Hadir -> Terlambat -> Izin -> Sakit -> Cuti -> Tanpa
  // Keterangan. Jenis laporan LAIN (Kegiatan Khusus, Sholat, dll) TIDAK
  // terpengaruh - tetap murni kronologis seperti sebelumnya, karena daftar
  // prioritas ini spesifik untuk status Absen Masuk. Status di luar daftar
  // ini (seharusnya tidak ada untuk Absen Masuk) jatuh ke prioritas paling
  // akhir (99) sebagai jaga-jaga. Di dalam status yang sama, urutan tetap
  // kronologis (tanggal, lalu sortField) - rapi per kelompok status.
  const PRIORITAS_STATUS_ABSEN_MASUK = { 'Tugas Luar': 1, 'Hadir': 2, 'Terlambat': 3, 'Izin': 4, 'Sakit': 5, 'Cuti': 6, 'Tanpa Keterangan': 7 };
  const prioritasStatus = (status) => PRIORITAS_STATUS_ABSEN_MASUK[String(status).trim()] || 99;

  rows.sort((a, b) => {
    if (type === 'ABSEN_MASUK') {
      const pa = prioritasStatus(a.status), pb = prioritasStatus(b.status);
      if (pa !== pb) return pa - pb;
    }
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
      const val = row[config.fields[j]];
      rowObj[header] = val === undefined || val === null ? '' : val;
    });
    result.push(rowObj);
  });

  return { headers: config.headers, data: result };
}

/**
 * Rekap Kehadiran (Absen Masuk) milik diri sendiri, periode payroll berjalan
 * (21 - 20) - dipakai tombol "Rekap Kehadiran" di menu Absen Masuk, tampil di
 * popup. Sengaja dibuat handler TERPISAH dari getReport() (bukan memakainya
 * langsung) karena getReport() dibatasi HANYA untuk Admin/Piket/Kepsek -
 * di sini SIAPA PUN (kecuali Admin Utama, yang tidak punya absen pribadi -
 * tidak terikat ke satu sekolah) boleh melihat rekap kehadirannya sendiri,
 * tidak perlu login sebagai admin. Bentuk hasilnya SAMA PERSIS dengan
 * getReport() ({headers, data}) supaya bisa dirender pakai fungsi render
 * tabel laporan yang sudah ada di frontend, tanpa kode render terpisah.
 */
// Batas mundur navigasi periode di popup Rekap Kehadiran (jumlah periode 21-20
// ke belakang dari periode berjalan). Frontend memakai angka yang sama dari
// respons (maxMundur), jadi cukup diubah di sini.
const REKAP_SENDIRI_MAKS_MUNDUR = 12;

async function getRekapAbsenMasukSendiri(args, env) {
  // args[1] (opsional): offsetPeriode - 0/kosong = periode berjalan (perilaku
  // lama, tetap sama persis), -1 = periode sebelumnya, dst. Nilai dari klien
  // TIDAK dipercaya begitu saja: dipaksa jadi bilangan bulat, tidak boleh
  // positif (periode masa depan), dan dibatasi maksimal REKAP_SENDIRI_MAKS_MUNDUR.
  const [token, offsetMentah] = args;
  const user = await requireUser(env, token);
  if (!user) return { headers: [], data: [] };
  if (user.role === 'ADMIN_UTAMA') return { headers: [], data: [] };

  let offsetPeriode = Math.trunc(Number(offsetMentah));
  if (!Number.isFinite(offsetPeriode)) offsetPeriode = 0;
  offsetPeriode = Math.max(-REKAP_SENDIRI_MAKS_MUNDUR, Math.min(0, offsetPeriode));

  const sekolahId = user.sekolahId;
  const config = REPORT_CONFIG.ABSEN_MASUK;
  const { start, end, label } = getPeriodeByOffset(offsetPeriode);
  const sDateStr = toDateStr(start);
  const eDateStr = toDateStr(end);

  const rows = await sbSelect(env, config.table,
    `sekolah_id=eq.${sekolahId}&nuptk=eq.${encodeURIComponent(user.nuptk)}&${config.dateField}=gte.${sDateStr}&${config.dateField}=lte.${eDateStr}`);

  rows.sort((a, b) => (a[config.dateField] < b[config.dateField] ? -1 : a[config.dateField] > b[config.dateField] ? 1 : 0));

  const data = rows.map((row) => {
    const rowObj = {};
    config.headers.forEach((header, j) => {
      const val = row[config.fields[j]];
      rowObj[header] = val === undefined || val === null ? '' : val;
    });
    return rowObj;
  });

  return {
    headers: config.headers, data, periodeLabel: label, namaGuru: user.nama, sekolahId,
    offsetPeriode, maxMundur: REKAP_SENDIRI_MAKS_MUNDUR
  };
}

/**
 * Perantara gambar Drive -> data URI (base64), dipakai fitur "Simpan Gambar (PNG)"
 * di Laporan. Browser TIDAK bisa menggambar logo/TTD dari drive.google.com ke
 * canvas (tidak ada header CORS -> canvas "tainted"/gambar hilang), jadi Worker
 * yang mengunduhnya lalu mengirim balik sebagai data URI. Dikunci ketat: hanya
 * URL thumbnail Drive dengan ID file yang valid (cegah dipakai sebagai proxy
 * ke alamat lain), hanya tipe image/*, maksimal 2 MB. Di-cache 1 jam di KV.
 */
async function getGambarDataUri(args, env) {
  const [token, url] = args;
  const user = await requireUser(env, token);
  if (!user) throw new Error('Sesi tidak valid.');

  const fileId = ambilFileIdDariUrl(url);
  if (!/^https:\/\/drive\.google\.com\/thumbnail\?/.test(String(url || '')) || !fileId || !/^[A-Za-z0-9_-]{10,120}$/.test(fileId)) {
    throw new Error('URL gambar tidak valid.');
  }

  return cached(env, `GAMBAR_DATAURI_${fileId}`, 3600, async () => {
    const res = await fetch(`https://drive.google.com/thumbnail?id=${fileId}&sz=w1000`);
    if (!res.ok) throw new Error(`Gagal mengambil gambar dari Drive (${res.status}).`);
    const tipe = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!tipe.startsWith('image/')) throw new Error('Respons Drive bukan gambar.');
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > 2 * 1024 * 1024) throw new Error('Ukuran gambar terlalu besar.');
    let biner = '';
    for (let i = 0; i < buf.length; i += 0x8000) {
      biner += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    }
    return { dataUri: `data:${tipe};base64,${btoa(biner)}` };
  });
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

/**
 * Skor Kinerja Guru - menggabungkan Rekap Absen Masuk (Skor Kehadiran, semua
 * staf) dan Rekap Jam Pelajaran (Skor Mengajar, cuma yang punya Kewajiban
 * Mengajar) sesuai Aturan Penilaian yang diatur Admin Utama. Periode SAMA
 * PERSIS dengan Rekap Payroll (bukan periode terpisah).
 *
 * Skor Kehadiran: HANYA Cuti dan Tugas Dinas yang DIKECUALIKAN dari pembagi
 * (keduanya sepenuhnya di luar kendali guru - cuti resmi terdaftar & tugas
 * dinas dari sekolah). Sakit dan Izin TETAP masuk pembagi dan tetap dapat
 * poin sebagian lewat bobotnya sendiri (default Sakit 0.1, Izin 0.2) - dibuat
 * rendah karena walau sah, terlalu sering sakit/izin tetap mengurangi
 * kehadiran fisik guru di sekolah.
 *
 * Skor Mengajar: Kewajiban Mengajar/minggu (dari SK, field kewajiban_mengajar_jp
 * di Data Guru) dikonversi ke kuota JP untuk periode ini berdasarkan jumlah
 * minggu kalender dalam rentang tanggal yang diminta (bukan hari kerja - lebih
 * sederhana dan cukup akurat karena periode payroll selalu dekat 1 bulan penuh).
 * Sama seperti Skor Kehadiran, cuma Tugas Dinas (di level JP) yang dikecualikan
 * dari pembagi - JP tidak punya konsep "Cuti" tersendiri (menu Cuti/Sakit Guru
 * cuma memengaruhi absen_masuk harian, bukan rekap per-JP). Sakit & Izin di
 * level JP pakai bobot yang SAMA dengan Skor Kehadiran (bobot_sakit/bobot_izin
 * dipakai bersama di kedua formula, bukan diatur terpisah).
 *
 * Bonus Impal (jadi guru badal, dari getPayrollJamPelajaran) berlaku untuk
 * SEMUA staf yang pernah impal - masuk ke Skor Mengajar untuk yang punya
 * Kewajiban Mengajar, atau ditambahkan ke Skor Kehadiran untuk yang tidak
 * (mis. Piket/Admin yang sesekali jadi guru badal).
 */
async function getNilaiGuru(args, env) {
  const [token, startDate, endDate, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user) && !isRole(user, 'PIKET', 'KEPALA_SEKOLAH')) return [];
  const sekolahId = resolveSekolahId(user, requestedSekolahId);

  const [dataAbsen, dataJP, aturan, users] = await Promise.all([
    getPayrollReport([token, startDate, endDate, requestedSekolahId], env),
    getPayrollJamPelajaran([token, startDate, endDate, requestedSekolahId], env),
    bacaAturanPenilaianInternal(env),
    getUsersListCached(env, sekolahId)
  ]);

  const bobotTerlambatKehadiran = parseFloat(aturan.bobot_terlambat_kehadiran) || 0;
  const bobotAlpaKehadiran = parseFloat(aturan.bobot_alpa_kehadiran) || 0;
  const bobotSakit = parseFloat(aturan.bobot_sakit) || 0;
  const bobotIzin = parseFloat(aturan.bobot_izin) || 0;
  const bobotTerlambatJp = parseFloat(aturan.bobot_terlambat_jp) || 0;
  const bobotAlpaJp = parseFloat(aturan.bobot_alpa_jp) || 0;
  const bonusPerImpal = parseFloat(aturan.bonus_per_impal) || 0;
  const maksBonusImpal = parseFloat(aturan.maks_bonus_impal) || 0;
  const ambangSangatBaik = parseFloat(aturan.predikat_sangat_baik) || 90;
  const ambangBaik = parseFloat(aturan.predikat_baik) || 80;
  const ambangCukup = parseFloat(aturan.predikat_cukup) || 70;

  const kewajibanMap = {};
  users.forEach((u) => { kewajibanMap[String(u.nuptk).trim()] = u.kewajiban_mengajar_jp || null; });

  const jpMap = {};
  dataJP.forEach((j) => { jpMap[String(j.nuptk).trim()] = j; });

  // Konversi Kewajiban Mengajar/minggu -> kuota JP untuk periode ini, lewat
  // jumlah minggu KALENDER dalam rentang tanggal (bukan hari kerja - lebih
  // sederhana, cukup akurat untuk periode ~1 bulan).
  const totalHariPeriode = Math.round((new Date(endDate) - new Date(startDate)) / 86400000) + 1;
  const mingguEfektif = totalHariPeriode / 7;

  const hitungPredikat = (skor) => {
    if (skor >= ambangSangatBaik) return 'Sangat Baik';
    if (skor >= ambangBaik) return 'Baik';
    if (skor >= ambangCukup) return 'Cukup';
    return 'Perlu Perhatian';
  };

  return dataAbsen.map((row) => {
    const nuptk = String(row.nuptk).trim();
    // row.sakit sudah gabungan Sakit+Cuti (untuk tampilan payroll) - di sini
    // dipisah lagi pakai row.cuti (murni Cuti) supaya cuma Cuti yang
    // dikecualikan, sedangkan Sakit murni tetap kena bobot sendiri.
    const sakitMurni = row.sakit - row.cuti;
    const totalHariKerja = row.hadir + row.terlambat + row.sakit + row.izin + row.tugasLuar + row.alpa;
    const hariRelevan = totalHariKerja - (row.cuti + row.tugasLuar);

    let skorKehadiran = null;
    if (hariRelevan > 0) {
      skorKehadiran = ((row.hadir * 1) + (row.terlambat * bobotTerlambatKehadiran)
        + (sakitMurni * bobotSakit) + (row.izin * bobotIzin)
        + (row.alpa * bobotAlpaKehadiran)) / hariRelevan * 100;
    }

    const jp = jpMap[nuptk] || { impal: 0, terlambat: 0, sakit: 0, izin: 0, tugasLuar: 0, alpa: 0 };
    const kewajibanMingguan = kewajibanMap[nuptk];
    let skorMengajar = null;

    if (kewajibanMingguan) {
      const kuotaPeriode = kewajibanMingguan * mingguEfektif;
      const jpEfektif = kuotaPeriode - jp.tugasLuar;
      if (jpEfektif > 0) {
        const jpHadirImplisit = jpEfektif - jp.terlambat - jp.sakit - jp.izin - jp.alpa;
        const bonusImpal = Math.min(jp.impal * bonusPerImpal, maksBonusImpal);
        skorMengajar = Math.min((((jpHadirImplisit * 1) + (jp.terlambat * bobotTerlambatJp)
          + (jp.sakit * bobotSakit) + (jp.izin * bobotIzin)
          + (jp.alpa * bobotAlpaJp)) / jpEfektif * 100) + bonusImpal, 100);
      }
    } else if (jp.impal > 0 && skorKehadiran !== null) {
      // Tidak punya Kewajiban Mengajar tapi pernah jadi guru badal - bonus
      // kontribusinya ditambahkan ke Skor Kehadiran (satu-satunya skor mereka).
      const bonusImpal = Math.min(jp.impal * bonusPerImpal, maksBonusImpal);
      skorKehadiran = Math.min(skorKehadiran + bonusImpal, 100);
    }

    return {
      nuptk, nama: row.nama,
      punyaKewajibanMengajar: !!kewajibanMingguan,
      skorKehadiran: skorKehadiran !== null ? Math.round(skorKehadiran * 10) / 10 : null,
      predikatKehadiran: skorKehadiran !== null ? hitungPredikat(skorKehadiran) : '-',
      skorMengajar: skorMengajar !== null ? Math.round(skorMengajar * 10) / 10 : null,
      predikatMengajar: skorMengajar !== null ? hitungPredikat(skorMengajar) : '-'
    };
  });
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

/**
 * List rekap jam pelajaran untuk SATU tanggal, sekolah sendiri saja - dipakai
 * untuk ditampilkan di bawah form input Rekap Jam Pelajaran supaya Piket/Admin
 * bisa langsung koreksi entri yang salah tanpa buka menu/database terpisah.
 * Default tanggal hari ini kalau tidak dikirim.
 */
async function getRekapJamPelajaranList(args, env) {
  const [token, tanggal, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user) && !isRole(user, 'PIKET')) return [];
  const sekolahId = resolveSekolahId(user, requestedSekolahId);

  const dateStr = tanggal || nowJakarta().dateStr;
  const rows = await sbSelect(env, 'rekap_jam_pelajaran',
    `sekolah_id=eq.${sekolahId}&tanggal=eq.${dateStr}&order=jam_ke.asc`);

  return rows.map((r) => ({
    id: r.id, tanggal: r.tanggal, nuptk: r.nuptk, namaGuru: r.nama_guru,
    jamKe: r.jam_ke, status: r.status, guruImpal: r.guru_impal,
    nuptkImpal: r.nuptk_impal, diinputOleh: r.diinput_oleh, timestamp: r.timestamp
  }));
}

const STATUS_JP_VALID = ['Terlambat', 'Sakit', 'Izin', 'Tugas Luar', 'Tanpa Keterangan'];

/** Edit satu baris rekap jam pelajaran (koreksi salah input Piket). */
async function updateRekapJamPelajaran(args, env) {
  const [token, id, status, guruImpalNama, guruImpalNuptk, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user) && !isRole(user, 'PIKET')) return { success: false, message: 'Akses ditolak.' };
  if (!id) return { success: false, message: 'Data tidak ditemukan (id kosong).' };
  if (!STATUS_JP_VALID.includes(status)) return { success: false, message: 'Status tidak dikenal: ' + status };
  const sekolahId = resolveSekolahId(user, requestedSekolahId);

  const rows = await sbSelect(env, 'rekap_jam_pelajaran', `id=eq.${encodeURIComponent(id)}&limit=1`);
  const existing = rows[0];
  if (!existing) return { success: false, message: 'Data tidak ditemukan (mungkin sudah dihapus).' };
  if (existing.sekolah_id !== sekolahId) {
    return { success: false, message: 'Akses ditolak. Data ini bukan milik sekolah Anda.' };
  }

  await sbUpdate(env, 'rekap_jam_pelajaran', 'id', id, {
    status, guru_impal: guruImpalNama || '-', nuptk_impal: guruImpalNuptk || '-'
  });
  return { success: true, message: `Data ${existing.nama_guru} (${existing.jam_ke}) berhasil diperbarui.` };
}

/** Hapus satu baris rekap jam pelajaran (salah input total, mis. salah guru/jam). */
async function deleteRekapJamPelajaran(args, env) {
  const [token, id, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user) && !isRole(user, 'PIKET')) return { success: false, message: 'Akses ditolak.' };
  if (!id) return { success: false, message: 'Data tidak ditemukan (id kosong).' };
  const sekolahId = resolveSekolahId(user, requestedSekolahId);

  const rows = await sbSelect(env, 'rekap_jam_pelajaran', `id=eq.${encodeURIComponent(id)}&limit=1`);
  const existing = rows[0];
  if (!existing) return { success: false, message: 'Data tidak ditemukan (mungkin sudah dihapus).' };
  if (existing.sekolah_id !== sekolahId) {
    return { success: false, message: 'Akses ditolak. Data ini bukan milik sekolah Anda.' };
  }

  await sbDelete(env, 'rekap_jam_pelajaran', 'id', id);
  return { success: true, message: `Data ${existing.nama_guru} (${existing.jam_ke}) berhasil dihapus.` };
}

// ====================================================================
// FCM / NOTIFIKASI (dipanggil dari frontend & dari cron)
// ====================================================================

/**
 * Kirim push notification (FCM) manual dari Admin Sekolah/Admin Utama - dipakai
 * untuk fitur "Kirim Notifikasi" di Admin Panel (pengumuman bebas ke guru,
 * SEKALIGUS alat uji coba apakah notifikasi sampai ke HP atau tidak).
 *
 * targetNuptk menentukan penerima:
 * - 'SEMUA'   -> broadcast ke semua staf berstatus Aktif di sekolah (kecuali
 *                Admin Utama - bukan staf spesifik 1 sekolah).
 * - 'SENDIRI' -> kirim ke device Admin yang SEDANG LOGIN saat ini - cara
 *                tercepat untuk Admin menguji sendiri apakah notifikasi
 *                sungguhan sampai di HP-nya, tanpa perlu minta tolong guru
 *                lain untuk mengecek.
 * - NUPTK staf tertentu -> kirim ke 1 orang saja - berguna untuk uji coba
 *   per-guru juga, mis. menelusuri kenapa 1 guru tertentu tidak pernah
 *   dapat notifikasi (biasanya karena belum pernah mengizinkan notifikasi
 *   di browser-nya, sehingga fcm_token masih kosong).
 */
async function kirimNotifikasiAdmin(args, env) {
  const [token, targetNuptk, judul, pesan, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user)) return { success: false, message: 'Akses ditolak.' };
  if (!judul || !judul.trim() || !pesan || !pesan.trim()) {
    return { success: false, message: 'Judul dan Pesan notifikasi wajib diisi.' };
  }

  let targets = [];
  if (targetNuptk === 'SENDIRI') {
    // Tidak butuh resolveSekolahId sama sekali - uji coba ke diri sendiri
    // relevan buat Admin Utama juga TANPA harus pilih sekolah dulu.
    targets = await sbSelect(env, 'users', `nuptk=eq.${encodeURIComponent(user.nuptk)}&limit=1`);
  } else if (targetNuptk === 'SEMUA') {
    const sekolahId = resolveSekolahId(user, requestedSekolahId);
    const users = await getUsersListCached(env, sekolahId);
    targets = users.filter((u) => String(u.status).trim() === 'Aktif' && String(u.role).trim() !== 'ADMIN_UTAMA');
  } else {
    targets = await sbSelect(env, 'users', `nuptk=eq.${encodeURIComponent(String(targetNuptk).trim())}&limit=1`);
  }
  if (!targets.length) return { success: false, message: 'Target penerima tidak ditemukan.' };

  let berhasil = 0;
  const catatanGagal = [];
  let jumlahTokenBasiDibersihkan = 0;
  for (const t of targets) {
    if (!t.fcm_token) {
      catatanGagal.push(`${t.nama} (belum pernah mengizinkan notifikasi di browsernya)`);
      continue;
    }
    try {
      const hasil = await kirimNotifikasiKeSatuHP(env, t.fcm_token, judul.trim(), pesan.trim());
      if (hasil.success) {
        berhasil++;
      } else if (hasil.tokenTidakValid) {
        // Token basi (guru pernah aktifkan notifikasi, tapi registrasinya di
        // Firebase sudah tidak berlaku lagi - mis. data browser sempat
        // dibersihkan) - dihapus dari database supaya tidak terus dicoba
        // kirim ke token yang sama tiap kali, dan supaya aplikasi otomatis
        // mendaftarkan token baru begitu guru itu membuka lagi (lihat
        // setupPushNotification() di frontend, jalan otomatis tiap buka app
        // kalau izin notifikasi browsernya masih aktif).
        await sbUpdate(env, 'users', 'nuptk', t.nuptk, { fcm_token: null });
        jumlahTokenBasiDibersihkan++;
        catatanGagal.push(`${t.nama} (registrasi notifikasi di HP-nya sudah kedaluwarsa - otomatis akan aktif lagi begitu dia membuka aplikasi)`);
      } else {
        catatanGagal.push(`${t.nama} (${hasil.message})`);
      }
    } catch (err) {
      catatanGagal.push(`${t.nama} (${err.message})`);
    }
  }

  let pesanHasil = `Notifikasi berhasil dikirim ke ${berhasil} dari ${targets.length} penerima.`;
  if (catatanGagal.length) {
    pesanHasil += ` Gagal: ${catatanGagal.slice(0, 5).join('; ')}${catatanGagal.length > 5 ? `, dan ${catatanGagal.length - 5} lainnya` : ''}.`;
  }
  return { success: berhasil > 0, message: pesanHasil };
}

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

  const daftarSekolah = await sbSelect(env, 'sekolah', "status=eq.Aktif");

  for (const sekolah of daftarSekolah) {
    const sekolahId = sekolah.id;
    const settings = await getSettingsMap(env, sekolahId);
    if (isHariLiburMingguan(settings, dayOfWeek)) {
      console.log(`[${sekolahId}] Hari libur mingguan sekolah ini. Notifikasi dibatalkan.`);
      continue;
    }
    const statusLibur = await checkApakahHariLibur(env, sekolahId, dateStr);
    if (statusLibur) {
      console.log(`[${sekolahId}] Hari ini libur: ${statusLibur}. Notifikasi dibatalkan.`);
      continue;
    }

    const users = await getUsersListCached(env, sekolahId);
    const absenHariIni = await sbSelect(env, 'absen_masuk', `sekolah_id=eq.${sekolahId}&tanggal=eq.${dateStr}`);
    const sudahAbsenNuptk = absenHariIni.map((r) => String(r.nuptk).trim());

    let jumlahDikirim = 0;
    let jumlahTokenBasiDibersihkan = 0;
    for (const u of users) {
      const uRole = String(u.role).trim(), uStatus = String(u.status).trim(), uNuptk = String(u.nuptk).trim();
      const fcmToken = u.fcm_token;
      if (['GURU', 'KEPALA_SEKOLAH', 'PIKET', 'ADMIN_SEKOLAH'].includes(uRole) && uStatus === 'Aktif') {
        if (!sudahAbsenNuptk.includes(uNuptk) && fcmToken) {
          const judul = 'Pengingat Absen Masuk ⏱️';
          const pesan = `Halo ${u.nama}, waktu sudah menunjukkan pukul 07.20 WIB. Mari segera lakukan absen masuk sebelum terlambat!`;
          const hasil = await kirimNotifikasiKeSatuHP(env, fcmToken, judul, pesan);
          if (hasil.success) {
            jumlahDikirim++;
          } else if (hasil.tokenTidakValid) {
            // Token basi - dibersihkan supaya tidak gagal diam-diam berulang
            // TIAP HARI tanpa pernah ketahuan (dulu hasil pengiriman ini sama
            // sekali tidak dicek). Lihat komentar lebih lengkap di
            // kirimNotifikasiAdmin().
            await sbUpdate(env, 'users', 'nuptk', uNuptk, { fcm_token: null });
            jumlahTokenBasiDibersihkan++;
          } else {
            console.warn(`[${sekolahId}] Gagal kirim notifikasi ke ${u.nama}:`, hasil.message);
          }
        }
      }
    }
    console.log(`[${sekolahId}] Selesai! Notifikasi dikirim ke ${jumlahDikirim} GTK yang belum absen.${jumlahTokenBasiDibersihkan ? ` (${jumlahTokenBasiDibersihkan} token FCM basi dibersihkan)` : ''}`);
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
  const { dateStr, dayOfWeek, timeStr } = nowJakarta();
  const ringkasan = { sekolahDiproses: [], sekolahDilewati: [], sekolahError: [], gagalDetail: [], totalDitandaiAlpa: 0 };

  const daftarSekolah = await sbSelect(env, 'sekolah', "status=eq.Aktif");
  console.log(`[autoSetTanpaKeterangan] Ditemukan ${daftarSekolah.length} sekolah berstatus Aktif untuk diproses (tanggal ${dateStr}).`);

  for (const sekolah of daftarSekolah) {
    await prosesAutoAlpaSatuSekolah(env, sekolah.id, dateStr, dayOfWeek, timeStr, ringkasan);
  }
  return ringkasan;
}

/**
 * Logika inti auto-alpa UNTUK SATU SEKOLAH SAJA - diambil dari isi loop
 * autoSetTanpaKeterangan() supaya bisa dipakai ulang oleh 2 pemicu berbeda:
 * 1) Trigger "oportunistik" setiap kali ADA guru yang Absen Pulang di suatu sekolah
 *    (lihat saveAbsenPulang) - HANYA memproses sekolah guru itu sendiri, bukan
 *    semua sekolah. Ini pemicu UTAMA sekarang (dulu ada cron khusus jam 13:01 &
 *    15:31 WIB, sudah dihapus - lihat wrangler.toml) - aktivitas nyata (ada yang
 *    pulang) dimanfaatkan sebagai "denyut" untuk mengecek ulang sekolah itu saat
 *    itu juga, tanpa perlu slot Cron Trigger sendiri (jatah akun gratis Cloudflare
 *    cuma 5). Konsekuensinya: begitu trigger ini sempat jalan untuk suatu sekolah
 *    hari itu (karena ada guru lain yang sudah pulang duluan), guru LAIN di
 *    sekolah yang sama yang baru mau Absen Masuk SETELAH momen itu akan ditolak
 *    sistem (duplicate key - baris "Tanpa Keterangan" keburu dibuat sistem
 *    untuknya). Sebelum trigger manapun sempat jalan, absen normal (termasuk
 *    yang terlambat) masih diterima seperti biasa.
 * 2) Cron terjadwal jam 18:00 WIB (lewat autoSetTanpaKeterangan, loop SEMUA
 *    sekolah - lihat komentar lengkap di autoSetTidakAbsenSholat()) - JARING
 *    PENGAMAN TERAKHIR kalau kebetulan di suatu sekolah tidak ada satu pun guru
 *    yang Absen Pulang hari itu, jadi trigger oportunistik di atas tidak pernah
 *    terpanggil sama sekali.
 *
 * Menambah hasilnya ke objek `ringkasan` yang di-pass dari pemanggil (dipakai
 * bersama antar sekolah saat dipanggil dari loop cron).
 */
async function prosesAutoAlpaSatuSekolah(env, sekolahId, dateStr, dayOfWeek, timeStr, ringkasan) {
  try {
    const settings = await getSettingsMap(env, sekolahId);
    if ((settings.status_auto_alpa || 'Aktif') === 'Nonaktif') {
      console.log(`[${sekolahId}] Auto Alpa dinonaktifkan sementara oleh Admin.`);
      ringkasan.sekolahDilewati.push(`${sekolahId} (auto alpa nonaktif)`);
      return;
    }

    // Hari libur MINGGUAN bisa beda per sekolah (mis. MDT/DTA cuma libur Ahad,
    // bukan Sabtu+Ahad seperti sekolah reguler) - lihat isHariLiburMingguan().
    if (isHariLiburMingguan(settings, dayOfWeek)) {
      ringkasan.sekolahDilewati.push(`${sekolahId} (hari libur mingguan sekolah ini)`);
      return;
    }

    // Jam batas auto-alpa BISA BEDA per sekolah (mis. MDT/DTA yang masuk siang hari,
    // bukan pagi seperti sekolah reguler) - diatur lewat settings.jam_cutoff_alpa
    // (default '12:20' kalau belum pernah diisi admin, supaya sekolah lama yang belum
    // sempat set field ini tetap jalan seperti biasa). Sekolah cuma benar-benar
    // diproses begitu waktu SEKARANG sudah melewati jam batasnya sendiri. Aman
    // dipanggil berkali-kali sehari untuk sekolah yang sama - begitu sekali berhasil
    // ditandai, kandidatnya otomatis jadi 0 di pemanggilan berikutnya (sudah ada
    // baris hari ini).
    const jamCutoff = settings.jam_cutoff_alpa || '12:20';
    if (timeStr < jamCutoff) {
      ringkasan.sekolahDilewati.push(`${sekolahId} (belum lewat jam cutoff ${jamCutoff}, sekarang ${timeStr})`);
      return;
    }

    const statusLibur = await checkApakahHariLibur(env, sekolahId, dateStr);
    if (statusLibur) {
      ringkasan.sekolahDilewati.push(`${sekolahId} (libur: ${statusLibur})`);
      return;
    }

    const users = await getUsersListCached(env, sekolahId);
    const absenHariIni = await sbSelect(env, 'absen_masuk', `sekolah_id=eq.${sekolahId}&tanggal=eq.${dateStr}`);
    const sudahAbsenHariIni = absenHariIni.map((r) => String(r.nuptk).trim());
    // Guru yang sedang dalam rentang Cuti/Sakit (dicatat manual admin lewat menu
    // Cuti/Sakit Guru) DIKECUALIKAN dari auto Tanpa Keterangan - lihat
    // getGuruCutiAktifHariIni().
    const guruCutiMap = await getGuruCutiAktifHariIni(env, sekolahId, dateStr);

    // Kumpulkan dulu semua baris yang perlu ditambahkan, baru kirim 1x lewat bulk
    // insert (bukan 1 request HTTP per guru) - supaya tidak menabrak limit
    // "Too many subrequests by single Worker invocation" di Cloudflare kalau
    // jumlah guru banyak. NB: latitude/longitude/jarak dikirim null (bukan teks
    // placeholder seperti '-' atau '0 m') - kolom-kolom ini bertipe numeric di
    // Supabase (terbukti dari log error "invalid input syntax for type numeric"),
    // jadi teks apapun selain angka murni akan selalu ditolak. null valid karena
    // memang tidak ada GPS sungguhan untuk baris "Tanpa Keterangan" otomatis ini.
    let jumlahEligible = 0; // masuk kriteria role+status aktif (calon "wajib absen")
    let jumlahSedangCuti = 0;
    const calonBaris = [];
    for (const u of users) {
      const userRole = String(u.role).trim(), userStatus = String(u.status).trim();
      const userNuptk = String(u.nuptk).trim(), userNama = String(u.nama).trim();

      if (['GURU', 'KEPALA_SEKOLAH', 'PIKET', 'ADMIN_SEKOLAH'].includes(userRole) && userStatus === 'Aktif') {
        jumlahEligible++;
        if (guruCutiMap[userNuptk]) {
          jumlahSedangCuti++;
          continue;
        }
        if (!sudahAbsenHariIni.includes(userNuptk)) {
          calonBaris.push({
            id: generateShortID('AO'), sekolah_id: sekolahId, tanggal: dateStr, nuptk: userNuptk, nama: userNama,
            jam: '--:--', latitude: null, longitude: null, jarak: null,
            status: 'Tanpa Keterangan', keterangan: 'Tidak Absen!', maps_link: '-'
          });
        }
      }
    }
    // Rincian debug ini SENGAJA selalu disertakan (bukan cuma pas error) - supaya
    // kalau "Total ditandai" ternyata 0 padahal harusnya tidak, bisa langsung
    // ketahuan di tahap mana penyebabnya tanpa perlu buka log Cloudflare:
    // total user di tabel 'users' utk sekolah ini, berapa yang lolos filter
    // role+status Aktif, berapa yang sedang cuti/sakit (dikecualikan), dan berapa
    // yang sistem anggap sudah absen hari ini.
    const debugInfo = `total user: ${users.length}, eligible (role+aktif): ${jumlahEligible}, sedang cuti/sakit: ${jumlahSedangCuti}, sudah ada baris hari ini: ${sudahAbsenHariIni.length}`;

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
            if (!String(err2.message).includes('duplicate key')) {
              console.error(`[${sekolahId}] Gagal insert 1 baris (${baris.nuptk}):`, err2.message);
              if (ringkasan.gagalDetail.length < 5) ringkasan.gagalDetail.push(`${sekolahId} (${baris.nuptk}): ${err2.message}`);
            }
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
    // dicatat, lalu LANJUT ke sekolah berikutnya (kalau dipanggil dari loop cron),
    // bukan berhenti total.
    console.error(`[${sekolahId}] GAGAL auto alpa:`, err.message);
    ringkasan.sekolahError.push(`${sekolahId}: ${err.message}`);
  }
}

/**
 * Dipanggil sebagai efek samping setelah Absen Pulang berhasil disimpan (lihat
 * saveAbsenPulang) - versi "sekali pakai, 1 sekolah" dari trigger oportunistik di
 * atas. Sengaja dibungkus try/catch SENDIRI di sini (terpisah dari try/catch
 * saveAbsenPulang) supaya kalau proses auto-alpa ini gagal karena sebab apa pun,
 * Absen Pulang guru yang barusan berhasil TETAP dianggap sukses - ini cuma efek
 * samping tambahan, bukan bagian inti dari aksi guru itu sendiri.
 */
async function trigerAutoAlpaOportunistik(env, sekolahId) {
  try {
    const { dateStr, dayOfWeek, timeStr } = nowJakarta();
    const ringkasanSementara = { sekolahDiproses: [], sekolahDilewati: [], sekolahError: [], gagalDetail: [], totalDitandaiAlpa: 0 };
    await prosesAutoAlpaSatuSekolah(env, sekolahId, dateStr, dayOfWeek, timeStr, ringkasanSementara);
    if (ringkasanSementara.totalDitandaiAlpa > 0) {
      console.log(`[trigerAutoAlpaOportunistik] Dipicu oleh Absen Pulang - ${sekolahId}: ${ringkasanSementara.totalDitandaiAlpa} guru ditandai Tanpa Keterangan.`);
    }
  } catch (err) {
    console.error(`[trigerAutoAlpaOportunistik] Gagal (sekolah ${sekolahId}):`, err.message);
  }
}

/**
 * Push notification pengingat "Absen Pulang & Sholat Dzuhur/Ashar" - dipicu
 * OPORTUNISTIK oleh aktivitas nyata (ada guru yang Absen Pulang di sekolah
 * itu), BUKAN oleh jadwal cron - sama seperti trigerAutoAlpaOportunistik(),
 * memanfaatkan momen ada guru pulang sebagai sinyal "sudah sore, waktunya
 * ingatkan yang lain" tanpa perlu slot Cron Trigger tambahan.
 *
 * PENGAMAN ANTI-SPAM (paling penting di fungsi ini): tanpa ini, notifikasi
 * yang SAMA akan terkirim berkali-kali sehari - setiap satu guru pulang,
 * semua guru lain yang belum pulang/sholat kebanjiran notifikasi identik.
 * Makanya dijaga lewat KV (env.SESSIONS) dengan kunci per sekolah PER HARI -
 * begitu batch pengingat ini sukses terkirim SEKALI untuk sekolah & tanggal
 * tertentu, ditandai dan tidak akan dikirim ulang lagi hari itu, walau ada
 * puluhan guru lain yang menyusul pulang setelahnya. Penanda ditulis SEBELUM
 * proses kirim selesai (bukan sesudah) supaya 2 guru yang pulang nyaris
 * bersamaan tidak sama-sama lolos memicu pengiriman ganda.
 *
 * Guru yang diingatkan: yang hari ini Hadir/Terlambat (hadir fisik) TAPI
 * belum Absen Pulang, dan/atau belum tercatat Sholat Dzuhur, dan/atau belum
 * Sholat Ashar - pesannya menyesuaikan persis kombinasi apa saja yang masih
 * kurang dari orang itu (tidak menyebut yang sudah beres).
 */
async function trigerPengingatPulangOportunistik(env, sekolahId) {
  try {
    const { dateStr } = nowJakarta();
    const kunciSudahKirim = `PENGINGAT_PULANG_TERKIRIM_${sekolahId}_${dateStr}`;
    if (await env.SESSIONS.get(kunciSudahKirim)) return; // sudah pernah dikirim hari ini untuk sekolah ini

    // Ditandai SEKARANG (sebelum proses kirim benar-benar selesai) - jaga-jaga
    // 2 guru pulang nyaris bersamaan, supaya cuma 1 yang lolos memicu kirim.
    await env.SESSIONS.put(kunciSudahKirim, '1', { expirationTtl: 43200 }); // 12 jam cukup, besok reset sendiri lewat tanggal yang beda di kunci

    const [users, absenHariIni, sholatDzuhurHariIni, sholatAsharHariIni] = await Promise.all([
      getUsersListCached(env, sekolahId),
      sbSelect(env, 'absen_masuk', `sekolah_id=eq.${sekolahId}&tanggal=eq.${dateStr}`),
      sbSelect(env, 'kegiatan_umum', `sekolah_id=eq.${sekolahId}&tanggal=eq.${dateStr}&jenis_kegiatan=eq.SHOLAT_DZUHUR`),
      sbSelect(env, 'kegiatan_umum', `sekolah_id=eq.${sekolahId}&tanggal=eq.${dateStr}&jenis_kegiatan=eq.SHOLAT_ASHAR`)
    ]);

    const absenMasukMap = {};
    absenHariIni.forEach((r) => { absenMasukMap[String(r.nuptk).trim()] = r; });
    const sudahDzuhurSet = new Set(sholatDzuhurHariIni.map((r) => String(r.nuptk).trim()));
    const sudahAsharSet = new Set(sholatAsharHariIni.map((r) => String(r.nuptk).trim()));

    let jumlahDikirim = 0;
    for (const u of users) {
      const uRole = String(u.role).trim(), uStatus = String(u.status).trim(), nuptk = String(u.nuptk).trim();
      if (!['GURU', 'KEPALA_SEKOLAH', 'PIKET', 'ADMIN_SEKOLAH'].includes(uRole) || uStatus !== 'Aktif' || !u.fcm_token) continue;

      const rowMasuk = absenMasukMap[nuptk];
      // Cuma relevan untuk yang memang hadir fisik hari ini - yang Sakit/Izin/
      // Tugas Dinas/Tanpa Keterangan/belum absen sama sekali tidak perlu (dan
      // tidak masuk akal) diingatkan soal pulang/sholat di sekolah.
      if (!rowMasuk || !['Hadir', 'Terlambat'].includes(String(rowMasuk.status).trim())) continue;

      const kurang = [];
      if (!sudahDzuhurSet.has(nuptk)) kurang.push('Sholat Dzuhur');
      if (!sudahAsharSet.has(nuptk)) kurang.push('Sholat Ashar');
      if (!rowMasuk.jam_pulang) kurang.push('Absen Pulang');
      if (kurang.length === 0) continue; // sudah lengkap semua, tidak perlu diingatkan

      try {
        const hasil = await kirimNotifikasiKeSatuHP(env, u.fcm_token, 'Pengingat Sore 🔔',
          `Halo ${u.nama}, jangan lupa: ${kurang.join(', ')} sebelum meninggalkan sekolah ya!`);
        if (hasil.success) {
          jumlahDikirim++;
        } else if (hasil.tokenTidakValid) {
          await sbUpdate(env, 'users', 'nuptk', nuptk, { fcm_token: null });
        }
      } catch (err) {
        console.error(`[trigerPengingatPulangOportunistik] Gagal kirim ke ${u.nama}:`, err.message);
      }
    }
    console.log(`[trigerPengingatPulangOportunistik] ${sekolahId}: ${jumlahDikirim} pengingat terkirim.`);
  } catch (err) {
    console.error(`[trigerPengingatPulangOportunistik] Gagal (sekolah ${sekolahId}):`, err.message);
  }
}

/**
 * Dipanggil dari Cron Trigger (1x sehari, jam 18:00 WIB - setelah waktu Dzuhur MAUPUN
 * Ashar pasti sudah lewat, dan jam pulang sekolah manapun juga pasti sudah lewat), atau
 * manual lewat tombol Admin Utama (jalankanAutoSholatManual). Guru yang tidak pernah
 * mengisi absen Pendampingan Sholat Dzuhur dan/atau Ashar hari itu (lewat menu
 * Kegiatan Sekolah) akan otomatis ditandai "Tidak Absen" untuk sesi yang terlewat - dulu
 * kalau tidak absen datanya cuma kosong/tidak ada baris sama sekali di kegiatan_umum,
 * jadi tidak kelihatan di laporan sebagai bahan evaluasi. Sekarang selalu ada baris
 * eksplisit "Tidak Absen" untuk sesi yang benar-benar terlewat.
 *
 * SEKALIAN menandai "Tidak Absen Pulang" (lihat prosesAutoTidakAbsenPulang di bawah) di
 * pemanggilan yang sama - digabung jadi 1 fungsi/1 Cron Trigger (bukan 3 slot terpisah
 * untuk Dzuhur, Ashar, Pulang) supaya hemat slot Cron Trigger Cloudflare (jatah akun
 * gratis cuma 5 total).
 *
 * SEKALIAN JUGA menjalankan autoSetTanpaKeterangan() (auto-alpa Absen Masuk) sebagai
 * JARING PENGAMAN TERAKHIR di penghujung hari - sejak tombol Absen Pulang jadi
 * pemicu oportunistik untuk auto-alpa (lihat trigerAutoAlpaOportunistik, dipanggil dari
 * saveAbsenPulang), cron KHUSUS auto-alpa (dulu jam 13:01 & 15:31 WIB) sudah dihapus -
 * pemicu utama sekarang murni aktivitas nyata guru yang Absen Pulang. TAPI kalau di
 * suatu sekolah TIDAK ADA satu pun guru yang Absen Pulang hari itu (lupa semua/libur
 * mendadak/dll), trigger oportunistik itu tidak akan pernah terpanggil sama sekali -
 * makanya cron 18:00 WIB ini tetap menjalankan auto-alpa 1x lagi untuk SEMUA sekolah
 * sebagai jaminan terakhir, tanpa perlu slot Cron Trigger tambahan (nebeng di cron yang
 * sudah ada).
 *
 * Sengaja dicek Dzuhur, Ashar, DAN Pulang dalam 1 pemanggilan jam 18:00 WIB (bukan cron
 * terpisah persis setelah tiap sesi) - lebih sederhana dan cukup aman karena jam 18:00
 * WIB semuanya pasti sudah lewat jauh. Waktu ini sebelumnya 21:00 WIB, digeser lebih awal
 * supaya juga masuk akal sebagai jam evaluasi "sudah pulang atau belum".
 *
 * Memakai toggle Admin yang sama dengan Auto Alpa Absen Masuk (settings.status_auto_alpa) -
 * supaya tidak perlu tambah menu Pengaturan baru; kalau nanti perlu tombol on/off terpisah
 * khusus otomasi sholat/pulang, tinggal ganti ke key settings baru di sini + tambah field
 * di form Pengaturan.
 */
export async function autoSetTidakAbsenSholat(env) {
  const SEMUA_JENIS = ['SHOLAT_DZUHUR', 'SHOLAT_ASHAR'];
  const { dateStr, dayOfWeek } = nowJakarta();
  const ringkasan = { sekolahDiproses: [], sekolahDilewati: [], sekolahError: [], gagalDetail: [], totalDitandaiTidakAbsen: 0 };

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

      // Hari libur MINGGUAN bisa beda per sekolah (mis. MDT/DTA cuma libur Ahad) -
      // lihat isHariLiburMingguan().
      if (isHariLiburMingguan(settings, dayOfWeek)) {
        ringkasan.sekolahDilewati.push(`${sekolahId} (hari libur mingguan sekolah ini)`);
        continue;
      }

      // Tidak semua sekolah punya jadwal Dzuhur/Ashar yang sama - mis. sekolah dengan
      // jam masuk siang (DTA/MDT, mulai belajar setelah Dzuhur) tidak punya kewajiban
      // Pendampingan Dzuhur sama sekali. Diatur lewat settings.wajib_absen_dzuhur /
      // wajib_absen_ashar ('Aktif' default kalau belum pernah diisi admin, supaya
      // sekolah lama yang belum sempat set field ini tetap jalan seperti biasa).
      const JENIS_DICEK = SEMUA_JENIS.filter((jenis) => {
        const key = jenis === 'SHOLAT_DZUHUR' ? 'wajib_absen_dzuhur' : 'wajib_absen_ashar';
        return (settings[key] || 'Aktif') !== 'Nonaktif';
      });
      if (JENIS_DICEK.length === 0) {
        ringkasan.sekolahDilewati.push(`${sekolahId} (Dzuhur & Ashar dinonaktifkan utk sekolah ini)`);
        continue;
      }

      const statusLibur = await checkApakahHariLibur(env, sekolahId, dateStr);
      if (statusLibur) {
        ringkasan.sekolahDilewati.push(`${sekolahId} (libur: ${statusLibur})`);
        continue;
      }

      const users = await getUsersListCached(env, sekolahId);
      // Guru yang sedang dalam rentang Cuti/Sakit (dicatat manual admin lewat menu
      // Cuti/Sakit Guru) DIKECUALIKAN dari auto Tidak Absen Sholat juga.
      const guruCutiMap = await getGuruCutiAktifHariIni(env, sekolahId, dateStr);

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
            if (guruCutiMap[userNuptk]) continue;
            if (!sudahAbsenNuptk.includes(userNuptk)) {
              calonBaris.push({
                id: generateShortID('KO'), sekolah_id: sekolahId, jenis_kegiatan: jenisKegiatan, tanggal: dateStr,
                nuptk: userNuptk, nama: userNama, kegiatan: jenisKegiatan, status: 'Tidak Absen',
                catatan: 'Otomatis oleh sistem - tidak melakukan absen sampai batas waktu.', timestamp: new Date().toISOString()
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
              if (!String(err2.message).includes('duplicate key')) {
                console.error(`[${sekolahId}] Gagal insert 1 baris (${baris.nuptk}, ${baris.jenis_kegiatan}):`, err2.message);
                if (ringkasan.gagalDetail.length < 5) ringkasan.gagalDetail.push(`${sekolahId} (${baris.nuptk}, ${baris.jenis_kegiatan}): ${err2.message}`);
              }
            }
          }
        }
      }
      const rincianJenis = `Dzuhur: ${berhasilPerJenis.SHOLAT_DZUHUR}, Ashar: ${berhasilPerJenis.SHOLAT_ASHAR}`;
      console.log(`[${sekolahId}] Selesai: ${ditandaiDiSekolahIni} baris Tidak Absen ditambahkan (${rincianJenis}).`);
      ringkasan.sekolahDiproses.push(`${sekolahId} (${ditandaiDiSekolahIni} ditandai — ${rincianJenis})`);
      ringkasan.totalDitandaiTidakAbsen += ditandaiDiSekolahIni;

      // Ditaruh di try/catch TERPISAH (bukan menyatu dengan try Sholat di atas) -
      // supaya kalau proses pulang gagal karena sebab apa pun, hasil Sholat yang
      // sudah berhasil dihitung di atas TETAP tercatat di ringkasan, tidak ikut
      // dianggap gagal juga.
      try {
        const jumlahPulang = await prosesAutoTidakAbsenPulangSatuSekolah(env, sekolahId, dateStr);
        if (jumlahPulang > 0) console.log(`[${sekolahId}] ${jumlahPulang} guru ditandai Tidak Absen Pulang.`);
        ringkasan.totalDitandaiTidakAbsenPulang = (ringkasan.totalDitandaiTidakAbsenPulang || 0) + jumlahPulang;
      } catch (errPulang) {
        console.error(`[${sekolahId}] GAGAL auto Tidak Absen Pulang:`, errPulang.message);
        ringkasan.gagalDetail.push(`${sekolahId} (auto tidak absen pulang): ${errPulang.message}`);
      }
    } catch (err) {
      console.error(`[${sekolahId}] GAGAL auto Tidak Absen Sholat:`, err.message);
      ringkasan.sekolahError.push(`${sekolahId}: ${err.message}`);
    }
  }

  // Jaring pengaman terakhir - lihat penjelasan lengkap di komentar atas fungsi ini.
  try {
    const ringkasanAlpa = await autoSetTanpaKeterangan(env);
    ringkasan.jaringPengamanAlpa = ringkasanAlpa;
  } catch (errAlpa) {
    console.error('[autoSetTidakAbsenSholat] Jaring pengaman auto-alpa gagal:', errAlpa.message);
    ringkasan.gagalDetail.push(`jaring pengaman auto-alpa: ${errAlpa.message}`);
  }

  return ringkasan;
}

/**
 * Menandai "Tidak Absen Pulang" untuk SATU sekolah - dipanggil dari
 * autoSetTidakAbsenSholat() di atas (gabung 1 Cron jam 18:00 WIB, lihat komentar
 * di atas fungsi itu). Guru yang punya baris absen_masuk hari ini (artinya
 * memang Hadir/Terlambat pagi tadi) TAPI kolom jam_pulang-nya masih kosong,
 * dianggap lupa/tidak melakukan Absen Pulang - ditandai eksplisit supaya
 * laporan tidak ambigu antara "belum waktunya pulang" vs "memang tidak pernah
 * absen pulang". TIDAK menyentuh guru yang absen_masuk-nya berstatus selain
 * Hadir/Terlambat (Sakit/Izin/Tugas Luar/Tanpa Keterangan) - mereka memang
 * tidak diharapkan absen pulang sama sekali karena tidak hadir fisik hari itu.
 * Return jumlah baris yang berhasil ditandai.
 */
async function prosesAutoTidakAbsenPulangSatuSekolah(env, sekolahId, dateStr) {
  const rows = await sbSelect(env, 'absen_masuk',
    `sekolah_id=eq.${sekolahId}&tanggal=eq.${dateStr}&jam_pulang=is.null&status=in.(Hadir,Terlambat)`);
  let jumlahDitandai = 0;
  for (const row of rows) {
    try {
      await sbUpdateWhere(env, 'absen_masuk', { sekolah_id: sekolahId, tanggal: dateStr, nuptk: row.nuptk },
        { jam_pulang: '--:--', lat_pulang: null, long_pulang: null, jarak_pulang: null });
      jumlahDitandai++;
    } catch (err) {
      console.error(`[${sekolahId}] Gagal menandai Tidak Absen Pulang utk ${row.nuptk}:`, err.message);
    }
  }
  return jumlahDitandai;
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
// RAPOR GTK - rapor kinerja bulanan guru & tenaga kependidikan
// ====================================================================
// Periode rapor = periode payroll (tanggal 21 - 20), diberi kunci 'YYYY-MM'
// berdasarkan bulan AKHIR periode (21 Des - 20 Jan = '2027-01' = "Januari 2027").
//
// Penyimpanan:
//  - Konfigurasi per sekolah (daftar indikator, bobot, penilai, jabatan/mulai
//    khidmah, ambang predikat) di Cloudflare KV, kunci RAPOR_CFG_<sekolah_id>
//    (pola yang sama dengan Aturan Penilaian global). Rapor aktif untuk sebuah
//    sekolah HANYA kalau konfigurasinya ada.
//  - Nilai per guru per indikator di tabel rapor_nilai (otomatis & manual).
//  - Status periode (DRAFT/FINAL) + salinan tetap (snapshot) di rapor_periode.
//    Setelah FINAL, rapor dibaca dari snapshot sehingga perubahan absen
//    sesudahnya tidak mengubah rapor yang sudah terbit.
// Skala nilai 0 - 10 (skor Kehadiran 0-100 dibagi 10).

const NAMA_BULAN_RAPOR = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const NAMA_BULAN_RAPOR_SINGKAT = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const ROLE_STAF_RAPOR = ['GURU', 'KEPALA_SEKOLAH', 'PIKET', 'ADMIN_SEKOLAH'];
const ASPEK_RAPOR = {
  A: 'A. PENILAIAN KEDISIPLINAN',
  B: 'B. PEDAGOGIK',
  C: 'C. PENILAIAN KEPRIBADIAN',
  D: 'D. PROFESIONAL'
};
const SUMBER_RAPOR_OTOMATIS = ['KEHADIRAN', 'KETEPATAN', 'TAWASUL', 'SHOLAT', 'PESANTREN', 'KEGIATAN_KHUSUS'];
const SUMBER_RAPOR_SEMUA = [...SUMBER_RAPOR_OTOMATIS, 'MANUAL'];
const JENIS_PESANTREN_DEFAULT = ['DZIKIR_MAKHSUS', 'PENGAJIAN_ARBAIN', 'QINI_NASIONAL_SUBUH', 'QINI_NASIONAL_MALAM'];
const KEY_BLOK_KEHADIRAN = ['H_SAKIT', 'H_IZIN_DINAS', 'H_IZIN', 'H_TK', 'H_TERLAMBAT', 'K_SAKIT', 'K_IZIN_DINAS', 'K_IZIN', 'K_TK', 'K_TERLAMBAT'];
// Kegiatan Pesantren memakai opsi 'Hadir di Majelis' / 'Hadir Streaming' / 'Berhalangan' (bukan 'Hadir');
// 'Hadir' tetap diterima untuk data lama.
const STATUS_PESANTREN_HADIR = ['Hadir', 'Hadir di Majelis', 'Hadir Streaming'];
const STATUS_SHOLAT_SAH = ['Berjamaah', 'Bertugas', 'Haid'];
const STATUS_KEGIATAN_DIKECUALIKAN = ['Izin Terkonfirmasi', 'Sakit'];
const STATUS_KHUSUS_DIKECUALIKAN = ['Izin', 'Sakit', 'Izin Terkonfirmasi', 'Tugas Luar', 'Cuti'];

const bulatkan2 = (x) => Math.round(x * 100) / 100;

function templateConfigRapor() {
  const I = (key, aspek, nama, sumber, extra) => Object.assign({ key, aspek, nama, sumber, bobot: 10, aktif: true }, extra || {});
  return {
    aktif: true,
    indikator: [
      I('I01', 'A', 'Jumlah Kehadiran & Absensi', 'KEHADIRAN'),
      I('I02', 'A', 'Kepatuhan terhadap Tata Tertib Guru', 'MANUAL'),
      I('I03', 'A', 'Ketepatan Waktu Setiap Kegiatan Sekolah dan Yayasan', 'KETEPATAN'),
      I('I04', 'B', 'Menyelesaikan Administrasi Guru', 'MANUAL'),
      I('I05', 'B', 'Melakukan Asesmen Siswa', 'MANUAL'),
      I('I20', 'B', 'Membawa Perangkat/Administrasi Pembelajaran', 'MANUAL'),
      I('I06', 'B', 'Kreatif dan Inovatif dalam Mengajar', 'MANUAL'),
      I('I08', 'C', 'Tawasul Harian', 'TAWASUL'),
      I('I09', 'C', 'Shalat Dzuhur / Ashar', 'SHOLAT'),
      I('I10', 'C', 'Adab Suluk (Dzikir Makhsus, Pengajian Arbain, Qini Nasional)', 'PESANTREN', { jenis: JENIS_PESANTREN_DEFAULT.slice() }),
      I('I11', 'C', 'Perhatian dan Aktif Terlibat dalam Kegiatan Sekolah', 'MANUAL'),
      I('I12', 'C', 'Piket Pembiasaan Sesuai Jadwal', 'MANUAL'),
      I('I13', 'C', 'Berpenampilan Rapih dan Sopan (seragam sesuai ketentuan)', 'MANUAL'),
      I('I15', 'D', 'Standar Pelayanan', 'MANUAL'),
      I('I16', 'D', 'Mengikuti Rapat Evaluasi GTK', 'KEGIATAN_KHUSUS', { kataKunci: 'rapat' }),
      I('I17', 'D', 'Mengikuti Pelatihan Mandiri', 'KEGIATAN_KHUSUS', { kataKunci: 'pelatihan' }),
      I('I18', 'D', 'Aktif dalam Kegiatan KKG', 'KEGIATAN_KHUSUS', { kataKunci: 'kkg' })
    ],
    penilai: { pedagogik: [], lainnya: [] },
    profil: {},
    ambang: { sangat_baik: 9, baik: 7.01, cukup: 5.51, sedang: 4.01 },
    tempat_titimangsa: '',
    ambang_acara_persen: 20,
    nilai_pesantren: { majelis: 10, streaming: 7, berhalangan: 0 }
  };
}

async function bacaConfigRapor(env, sekolahId) {
  const raw = await env.SESSIONS.get(`RAPOR_CFG_${sekolahId}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

async function tulisConfigRapor(env, sekolahId, cfg) {
  await env.SESSIONS.put(`RAPOR_CFG_${sekolahId}`, JSON.stringify(cfg));
}

/** Admin Utama wajib memilih sekolah; role lain selalu sekolah miliknya sendiri. */
function sekolahIdRapor(user, requestedSekolahId) {
  if (user.role === 'ADMIN_UTAMA') return requestedSekolahId || null;
  return user.sekolahId || null;
}

function rentangPeriodeRapor(periode) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(periode || ''));
  if (!m) return null;
  const tahun = parseInt(m[1], 10), bulan = parseInt(m[2], 10);
  const start = new Date(Date.UTC(tahun, bulan - 2, 21));
  const end = new Date(Date.UTC(tahun, bulan - 1, 20));
  return {
    periode: `${m[1]}-${m[2]}`, start, end, startStr: toDateStr(start), endStr: toDateStr(end),
    label: `${NAMA_BULAN_RAPOR[bulan - 1]} ${tahun}`,
    rentangLabel: `21 ${NAMA_BULAN_RAPOR_SINGKAT[start.getUTCMonth()]} ${start.getUTCFullYear()} - 20 ${NAMA_BULAN_RAPOR_SINGKAT[bulan - 1]} ${tahun}`
  };
}

function periodeRaporBerjalan() {
  return toDateStr(getPeriodeBerjalan().end).slice(0, 7);
}

function labelPeriodeRapor(periode) {
  const info = rentangPeriodeRapor(periode);
  return info ? info.label : String(periode);
}

function tanggalTitimangsaRapor() {
  const { year, month, day } = nowJakarta();
  return `${String(day).padStart(2, '0')} ${NAMA_BULAN_RAPOR[month - 1]} ${year}`;
}

/** Hak input per aspek. Pedagogik (B): Admin + penilai Kurikulum. Lainnya: Admin + Piket + penilai SDM. */
function hitungIzinRapor(user, cfg) {
  const nuptk = String(user.nuptk).trim();
  const penilai = cfg.penilai || {};
  const admin = isAdminAny(user);
  const pedagogik = admin || (penilai.pedagogik || []).includes(nuptk);
  const lainnya = admin || isRole(user, 'PIKET') || (penilai.lainnya || []).includes(nuptk);
  return { A: lainnya, B: pedagogik, C: lainnya, D: lainnya, info: lainnya };
}

function bisaLihatSemuaRapor(user, cfg) {
  if (isAdminAny(user) || isRole(user, 'KEPALA_SEKOLAH', 'PIKET')) return true;
  const iz = hitungIzinRapor(user, cfg);
  return iz.A || iz.B;
}

function predikatRapor(rata, ambang) {
  if (rata === null || rata === undefined) return '-';
  if (rata >= ambang.sangat_baik) return 'Sangat Baik';
  if (rata >= ambang.baik) return 'Baik';
  if (rata >= ambang.cukup) return 'Cukup';
  if (rata >= ambang.sedang) return 'Sedang';
  return 'Kurang';
}

/** Rapikan & validasi konfigurasi dari frontend. Return { cfg } atau { galat }. */
function bersihkanConfigRapor(input, lama) {
  if (!input || typeof input !== 'object') return { galat: 'Konfigurasi tidak valid.' };
  const daftar = Array.isArray(input.indikator) ? input.indikator : [];
  if (daftar.length < 1 || daftar.length > 40) return { galat: 'Jumlah indikator harus 1 sampai 40.' };

  const keyDipakai = new Set();
  const keyLama = new Set((lama.indikator || []).map((i) => i.key));
  let urutBaru = 100;
  const indikator = [];
  for (const raw of daftar) {
    const nama = String(raw.nama || '').trim().slice(0, 150);
    if (!nama) return { galat: 'Nama indikator tidak boleh kosong.' };
    const aspek = String(raw.aspek || '').trim();
    if (!ASPEK_RAPOR[aspek]) return { galat: `Aspek indikator "${nama}" tidak valid.` };
    const sumber = String(raw.sumber || 'MANUAL').trim();
    if (!SUMBER_RAPOR_SEMUA.includes(sumber)) return { galat: `Sumber nilai indikator "${nama}" tidak valid.` };
    const bobot = Number(raw.bobot);
    if (!isFinite(bobot) || bobot <= 0 || bobot > 100) return { galat: `Bobot indikator "${nama}" harus lebih dari 0 dan paling besar 100.` };

    let key = String(raw.key || '').trim();
    if (!/^I\d{2,3}$/.test(key) || keyDipakai.has(key)) {
      do { key = 'I' + (urutBaru++); } while (keyDipakai.has(key) || keyLama.has(key));
    }
    keyDipakai.add(key);

    const ind = { key, aspek, nama, sumber, bobot, aktif: raw.aktif !== false };
    if (sumber === 'KEGIATAN_KHUSUS') {
      ind.kataKunci = String(raw.kataKunci || '').trim().slice(0, 100);
      if (!ind.kataKunci) return { galat: `Indikator "${nama}" bersumber Kegiatan Khusus, isi kata kunci nama agenda.` };
    }
    if (sumber === 'PESANTREN') {
      const jenis = (Array.isArray(raw.jenis) ? raw.jenis : []).filter((j) => KEGIATAN_IDENTIK.includes(j));
      if (jenis.length === 0) return { galat: `Indikator "${nama}" bersumber Kegiatan Pesantren, pilih minimal satu jenis kegiatan.` };
      ind.jenis = jenis;
    }
    indikator.push(ind);
  }

  const bersihNuptk = (arr) => Array.from(new Set((Array.isArray(arr) ? arr : []).map((x) => String(x).trim()).filter(Boolean))).slice(0, 100);
  const penilai = {
    pedagogik: bersihNuptk(input.penilai && input.penilai.pedagogik),
    lainnya: bersihNuptk(input.penilai && input.penilai.lainnya)
  };

  const profil = {};
  Object.keys(input.profil || {}).slice(0, 500).forEach((n) => {
    const p = input.profil[n] || {};
    const urut = parseInt(p.urut, 10);
    profil[String(n).trim()] = {
      jabatan: String(p.jabatan || '').trim().slice(0, 80),
      mulai: String(p.mulai || '').trim().slice(0, 30),
      urut: isFinite(urut) && urut > 0 ? urut : null
    };
  });

  const a = input.ambang || {};
  const ambang = {
    sangat_baik: Number(a.sangat_baik), baik: Number(a.baik), cukup: Number(a.cukup), sedang: Number(a.sedang)
  };
  const nilaiAmbang = [ambang.sangat_baik, ambang.baik, ambang.cukup, ambang.sedang];
  if (nilaiAmbang.some((x) => !isFinite(x) || x < 0 || x > 10)) return { galat: 'Ambang predikat harus angka 0 sampai 10.' };
  if (!(ambang.sangat_baik > ambang.baik && ambang.baik > ambang.cukup && ambang.cukup > ambang.sedang)) {
    return { galat: 'Ambang predikat harus menurun: Sangat Baik > Baik > Cukup > Sedang.' };
  }

  const persen = Number(input.ambang_acara_persen);
  const np = input.nilai_pesantren || {};
  const nilaiPes = {};
  for (const [k, def] of [['majelis', 10], ['streaming', 7], ['berhalangan', 0]]) {
    const v = np[k] === '' || np[k] === undefined || np[k] === null ? def : Number(np[k]);
    if (!isFinite(v) || v < 0 || v > 10) return { galat: 'Nilai kehadiran pesantren harus angka 0 sampai 10.' };
    nilaiPes[k] = v;
  }
  return {
    cfg: {
      aktif: true, indikator, penilai, profil, ambang,
      peserta: (lama && lama.peserta) || {},
      tempat_titimangsa: String(input.tempat_titimangsa || '').trim().slice(0, 60),
      ambang_acara_persen: isFinite(persen) && persen >= 1 && persen <= 100 ? persen : 20,
      nilai_pesantren: nilaiPes
    }
  };
}

/**
 * Susun hasil rapor semua guru dari konfigurasi + baris rapor_nilai.
 * Status tiap sel: NILAI (ada angka), TIDAK_BERLAKU (dikeluarkan dari rata-rata),
 * BELUM (belum dinilai, tidak ikut dihitung). Pedagogik (aspek B) otomatis
 * TIDAK_BERLAKU untuk staf berkategori "Tidak Mengajar".
 */
/**
 * Staf yang ikut dirapor pada SEBUAH periode. Aturan bawaan (bukan hanya "yang aktif hari ini",
 * karena itu membuat guru yang baru dinonaktifkan hilang dari bulan-bulan lalu dan guru baru
 * muncul di bulan sebelum ia bergabung):
 *   - sudah punya nilai tersimpan di periode itu -> ikut (data tidak boleh "hilang")
 *   - selain itu: ikut bila berstatus Aktif DAN akunnya dibuat sebelum periode berakhir
 * Admin bisa menimpa per orang per periode lewat cfg.peserta[periode] = { tambah:[], keluar:[] }.
 * Return [{ u, nuptk, bawaan, ikut }] untuk semua staf (termasuk yang tidak ikut).
 */
function daftarStafPeriodeRapor(cfg, users, periode, endStr, nuptkAdaNilai) {
  const ov = (cfg.peserta || {})[periode] || {};
  const tambah = new Set((ov.tambah || []).map(String));
  const keluar = new Set((ov.keluar || []).map(String));
  return users
    .filter((u) => ROLE_STAF_RAPOR.includes(String(u.role).trim()))
    .map((u) => {
      const nuptk = String(u.nuptk).trim();
      const dibuat = u.created_at ? String(u.created_at).slice(0, 10) : '';
      const bawaan = nuptkAdaNilai.has(nuptk) || (String(u.status).trim() === 'Aktif' && (!dibuat || dibuat <= endStr));
      const ikut = keluar.has(nuptk) ? false : (tambah.has(nuptk) ? true : bawaan);
      return { u, nuptk, bawaan, ikut };
    });
}

function susunRaporPeriode(cfg, users, nilaiRows, periode, endStr) {
  const adaNilai = new Set(nilaiRows.map((r) => String(r.nuptk).trim()));
  const ikutSet = new Set(daftarStafPeriodeRapor(cfg, users, periode, endStr, adaNilai).filter((d) => d.ikut).map((d) => d.nuptk));
  const indikatorAktif = (cfg.indikator || []).filter((i) => i.aktif !== false);
  const peta = {};
  nilaiRows.forEach((r) => {
    const n = String(r.nuptk).trim();
    if (!peta[n]) peta[n] = {};
    peta[n][r.indikator_key] = r;
  });
  const profil = cfg.profil || {};
  const roster = users
    .filter((u) => ikutSet.has(String(u.nuptk).trim()))
    .sort((a, b) => {
      const ua = (profil[String(a.nuptk).trim()] || {}).urut || 99999;
      const ub = (profil[String(b.nuptk).trim()] || {}).urut || 99999;
      if (ua !== ub) return ua - ub;
      return String(a.nama).localeCompare(String(b.nama), 'id');
    });

  return roster.map((u) => {
    const nuptk = String(u.nuptk).trim();
    const baris = peta[nuptk] || {};
    const kategori = u.kategori || 'Mengajar';
    const items = {};
    let jumlah = 0, bobotTotal = 0, belum = 0;
    indikatorAktif.forEach((ind) => {
      let it;
      if (ind.aspek === 'B' && kategori !== 'Mengajar') {
        it = { status: 'TIDAK_BERLAKU', nilai: null, ket: 'Tidak mengajar', sumber: 'OTOMATIS' };
      } else {
        const r = baris[ind.key];
        if (!r || r.status === 'BELUM') {
          it = { status: 'BELUM', nilai: null, ket: '', sumber: ind.sumber === 'MANUAL' ? 'MANUAL' : 'OTOMATIS' };
        } else {
          it = { status: r.status, nilai: (r.nilai === null || r.nilai === undefined) ? null : Number(r.nilai), ket: r.keterangan || '', sumber: r.sumber || 'MANUAL' };
        }
      }
      items[ind.key] = it;
      if (it.status === 'NILAI' && it.nilai !== null) { jumlah += it.nilai * ind.bobot; bobotTotal += ind.bobot; }
      else if (it.status === 'BELUM') belum++;
    });
    const rata = bobotTotal > 0 ? bulatkan2(jumlah / bobotTotal) : null;
    const angka = (k) => (baris[k] && baris[k].nilai !== null && baris[k].nilai !== undefined) ? Number(baris[k].nilai) : null;
    const p = profil[nuptk] || {};
    return {
      nuptk, nama: u.nama, kategori, jabatan: p.jabatan || '', mulai: p.mulai || '', urut: p.urut || null,
      items, jumlah: bulatkan2(jumlah), bobotTotal, rata, predikat: predikatRapor(rata, cfg.ambang),
      jumlahBelum: belum,
      teguran: angka('TEGURAN') || 0,
      catatan: baris.CATATAN ? (baris.CATATAN.keterangan || '') : '',
      harian: { sakit: angka('H_SAKIT'), izinDinas: angka('H_IZIN_DINAS'), izin: angka('H_IZIN'), tk: angka('H_TK'), terlambat: angka('H_TERLAMBAT') },
      kbm: { sakit: angka('K_SAKIT'), izinDinas: angka('K_IZIN_DINAS'), izin: angka('K_IZIN'), tk: angka('K_TK'), terlambat: angka('K_TERLAMBAT') }
    };
  });
}

function ringkasIndikatorRapor(cfg) {
  return (cfg.indikator || []).filter((i) => i.aktif !== false)
    .map((i) => ({ key: i.key, aspek: i.aspek, nama: i.nama, bobot: i.bobot, sumber: i.sumber }));
}

async function upsertBertahap(env, tabel, baris, kolomKonflik, ukuran) {
  const per = ukuran || 400;
  for (let i = 0; i < baris.length; i += per) {
    await sbUpsertMany(env, tabel, baris.slice(i, i + per), kolomKonflik);
  }
}

async function ambilPeriodeRaporRow(env, sekolahId, periode, kolom) {
  const rows = await sbSelect(env, 'rapor_periode', `select=${kolom || '*'}&sekolah_id=eq.${encodeURIComponent(sekolahId)}&periode=eq.${periode}&limit=1`);
  return rows[0] || null;
}

// --------------------------------------------------------------------
// HANDLER
// --------------------------------------------------------------------

/** Status Rapor GTK untuk pengguna yang sedang login (menentukan menu mana yang tampil). */
async function getRaporConfig(args, env) {
  const [token, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!user) return { aktif: false };
  const sekolahId = sekolahIdRapor(user, requestedSekolahId);
  const bisaKelola = isAdminAny(user);
  if (!sekolahId) return { aktif: false, bisaKelola, perluPilihSekolah: user.role === 'ADMIN_UTAMA' };

  const cfg = await bacaConfigRapor(env, sekolahId);
  const aktif = !!cfg && cfg.aktif !== false;
  if (!aktif) return { aktif: false, bisaKelola };

  const bisaLihatSemua = bisaLihatSemuaRapor(user, cfg);
  return {
    aktif: true, bisaKelola, bisaLihatSemua,
    bisaFinalisasi: isAdminAny(user) || isRole(user, 'KEPALA_SEKOLAH'),
    bisaHitung: isAdminAny(user) || isRole(user, 'KEPALA_SEKOLAH', 'PIKET'),
    izinInput: hitungIzinRapor(user, cfg),
    periodeBerjalan: periodeRaporBerjalan(),
    config: (bisaKelola || bisaLihatSemua) ? cfg : null
  };
}

async function aktifkanRapor(args, env) {
  const [token, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user)) return { success: false, message: 'Akses ditolak.' };
  const sekolahId = sekolahIdRapor(user, requestedSekolahId);
  if (!sekolahId) return { success: false, message: 'Pilih sekolah dulu.' };

  const ada = await bacaConfigRapor(env, sekolahId);
  if (ada) {
    if (ada.aktif === false) { ada.aktif = true; await tulisConfigRapor(env, sekolahId, ada); }
    return { success: true, message: 'Rapor GTK sudah aktif untuk sekolah ini.' };
  }
  await tulisConfigRapor(env, sekolahId, templateConfigRapor());
  return { success: true, message: 'Rapor GTK diaktifkan dengan 19 indikator bawaan. Lengkapi Jabatan, Mulai Khidmah, dan Penilai di tab Pengaturan.' };
}

async function simpanRaporConfig(args, env) {
  const [token, configBaru, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user)) return { success: false, message: 'Akses ditolak.' };
  const sekolahId = sekolahIdRapor(user, requestedSekolahId);
  if (!sekolahId) return { success: false, message: 'Pilih sekolah dulu.' };
  const lama = await bacaConfigRapor(env, sekolahId);
  if (!lama) return { success: false, message: 'Rapor GTK belum diaktifkan untuk sekolah ini.' };

  const hasil = bersihkanConfigRapor(configBaru, lama);
  if (hasil.galat) return { success: false, message: hasil.galat };
  await tulisConfigRapor(env, sekolahId, hasil.cfg);
  return { success: true, message: 'Pengaturan Rapor GTK disimpan. Berlaku untuk periode yang belum difinalisasi.' };
}

async function getRaporPeriode(args, env) {
  const [token, periode, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!user) return { success: false, message: 'Sesi habis, silakan login ulang.' };
  const sekolahId = sekolahIdRapor(user, requestedSekolahId);
  if (!sekolahId) return { success: false, message: 'Pilih sekolah dulu.' };
  const cfg = await bacaConfigRapor(env, sekolahId);
  if (!cfg || cfg.aktif === false) return { success: false, message: 'Rapor GTK belum diaktifkan untuk sekolah ini.' };
  if (!bisaLihatSemuaRapor(user, cfg)) return { success: false, message: 'Akses ditolak.' };
  const info = rentangPeriodeRapor(periode);
  if (!info) return { success: false, message: 'Periode tidak valid.' };

  const dasar = {
    success: true, periode: info.periode, label: info.label, rentangLabel: info.rentangLabel,
    izinInput: hitungIzinRapor(user, cfg), aspek: ASPEK_RAPOR, ambang: cfg.ambang
  };

  const periodeRow = await ambilPeriodeRaporRow(env, sekolahId, info.periode);
  if (periodeRow && periodeRow.status === 'FINAL' && periodeRow.snapshot) {
    const s = periodeRow.snapshot;
    return Object.assign(dasar, {
      status: 'FINAL', difinalisasiOleh: periodeRow.difinalisasi_oleh, difinalisasiPada: periodeRow.difinalisasi_pada,
      indikator: s.indikator, ambang: s.ambang || cfg.ambang, titimangsa: s.titimangsa, guru: s.guru,
      otomatisDihitungPada: periodeRow.otomatis_dihitung_pada || null
    });
  }

  const [users, nilaiRows] = await Promise.all([
    getUsersListCached(env, sekolahId),
    sbSelectAll(env, 'rapor_nilai', `sekolah_id=eq.${encodeURIComponent(sekolahId)}&periode=eq.${info.periode}&order=nuptk.asc,indikator_key.asc`)
  ]);
  return Object.assign(dasar, {
    status: 'DRAFT', indikator: ringkasIndikatorRapor(cfg),
    titimangsa: { tempat: cfg.tempat_titimangsa || '', tanggal: tanggalTitimangsaRapor() },
    guru: susunRaporPeriode(cfg, users, nilaiRows, info.periode, info.endStr),
    otomatisDihitungPada: periodeRow ? periodeRow.otomatis_dihitung_pada : null,
    // Daftar semua staf untuk dialog "Atur Peserta Periode" (hanya yang berhak mengubahnya).
    semuaStaf: isAdminAny(user)
      ? daftarStafPeriodeRapor(cfg, users, info.periode, info.endStr, new Set(nilaiRows.map((r) => String(r.nuptk).trim())))
          .map((d) => ({ nuptk: d.nuptk, nama: d.u.nama, status: String(d.u.status).trim(), kategori: d.u.kategori || 'Mengajar', ikut: d.ikut }))
          .sort((a, b) => String(a.nama).localeCompare(String(b.nama), 'id'))
      : undefined
  });
}

/** Tarik semua nilai yang bisa dihitung dari data absensi, simpan sebagai baris OTOMATIS di rapor_nilai. */
async function hitungRaporOtomatis(args, env) {
  const [token, periode, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user) && !isRole(user, 'KEPALA_SEKOLAH', 'PIKET')) return { success: false, message: 'Akses ditolak.' };
  const sekolahId = sekolahIdRapor(user, requestedSekolahId);
  if (!sekolahId) return { success: false, message: 'Pilih sekolah dulu.' };
  const cfg = await bacaConfigRapor(env, sekolahId);
  if (!cfg || cfg.aktif === false) return { success: false, message: 'Rapor GTK belum diaktifkan untuk sekolah ini.' };
  const info = rentangPeriodeRapor(periode);
  if (!info) return { success: false, message: 'Periode tidak valid.' };
  if (info.periode > periodeRaporBerjalan()) return { success: false, message: 'Periode ini belum dimulai.' };

  const periodeRow = await ambilPeriodeRaporRow(env, sekolahId, info.periode, 'status');
  if (periodeRow && periodeRow.status === 'FINAL') {
    return { success: false, message: 'Periode ini sudah difinalisasi. Buka kembali dulu bila perlu menghitung ulang.' };
  }

  const hasil = await hitungNilaiOtomatisRapor(env, token, sekolahId, cfg, info, user);
  await upsertBertahap(env, 'rapor_nilai', hasil.baris, 'sekolah_id,periode,nuptk,indikator_key');
  await sbUpsertMany(env, 'rapor_periode', [{
    sekolah_id: sekolahId, periode: info.periode, tgl_mulai: info.startStr, tgl_selesai: info.endStr,
    status: 'DRAFT', otomatis_dihitung_pada: new Date().toISOString()
  }], 'sekolah_id,periode');

  return {
    success: true, jumlahGuru: hasil.jumlahGuru, jumlahIndikatorOtomatis: hasil.jumlahIndikatorOtomatis, sebagian: hasil.sebagian,
    message: `Nilai otomatis dihitung untuk ${hasil.jumlahGuru} orang (${hasil.jumlahIndikatorOtomatis} indikator otomatis). Nilai manual tidak diubah.`
      + (hasil.sebagian ? ` Periode belum berakhir, jadi dihitung sampai ${hasil.akhirEfektif}. Hitung ulang setelah tanggal 20.` : '')
  };
}

async function hitungNilaiOtomatisRapor(env, token, sekolahId, cfg, infoAsli, user) {
  let info = infoAsli;
  const indikatorOto = (cfg.indikator || []).filter((i) => i.aktif !== false && SUMBER_RAPOR_OTOMATIS.includes(i.sumber));
  const punyaSumber = (s) => indikatorOto.some((i) => i.sumber === s);

  const jenisDibutuhkan = new Set();
  if (punyaSumber('TAWASUL')) jenisDibutuhkan.add('BRIEFING_TAWASUL');
  if (punyaSumber('SHOLAT')) { jenisDibutuhkan.add('SHOLAT_DZUHUR'); jenisDibutuhkan.add('SHOLAT_ASHAR'); }
  indikatorOto.filter((i) => i.sumber === 'PESANTREN').forEach((i) => (i.jenis || []).forEach((j) => jenisDibutuhkan.add(j)));
  const daftarJenis = Array.from(jenisDibutuhkan);

  // Periode yang BELUM berakhir dihitung sampai hari ini saja. Tanpa pembatas ini, hari-hari
  // mendatang yang belum punya baris absen ikut terhitung "Tanpa Keterangan" oleh jaring
  // pengaman getPayrollReport (cocok untuk periode yang sudah lewat, menyesatkan di tengah periode).
  // Batasnya KEMARIN, bukan hari ini: absen hari ini belum lengkap (cron Auto Alpa baru jalan sore/malam).
  const hariIni = nowJakarta().dateStr;
  const kemarin = toDateStr(new Date(new Date(hariIni).getTime() - 86400000));
  const sebagian = info.endStr > kemarin;
  const akhirEfektif = sebagian ? kemarin : info.endStr;
  if (akhirEfektif < info.startStr) throw new Error('Periode ini baru dimulai hari ini, belum ada data yang bisa dihitung.');
  info = Object.assign({}, info, { endStr: akhirEfektif });

  const filterSekolah = `sekolah_id=eq.${encodeURIComponent(sekolahId)}`;
  const perluKhusus = punyaSumber('KETEPATAN') || punyaSumber('KEGIATAN_KHUSUS');

  const [users, nilaiGuru, payroll, jp, jadwal, khusus, ...umumPerJenis] = await Promise.all([
    getUsersListCached(env, sekolahId),
    punyaSumber('KEHADIRAN') ? getNilaiGuru([token, info.startStr, info.endStr, sekolahId], env) : [],
    getPayrollReport([token, info.startStr, info.endStr, sekolahId], env),
    getPayrollJamPelajaran([token, info.startStr, info.endStr, sekolahId], env),
    punyaSumber('KEGIATAN_KHUSUS') ? getJadwalKegiatanCached(env, sekolahId) : [],
    perluKhusus
      ? sbSelectAll(env, 'absen_kegiatan_khusus', `select=nuptk,tanggal_lapor,nama_kegiatan,status_kehadiran&${filterSekolah}&tanggal_lapor=gte.${info.startStr}&tanggal_lapor=lte.${info.endStr}&order=id.asc`)
      : [],
    ...daftarJenis.map((j) =>
      sbSelectAll(env, 'kegiatan_umum', `select=nuptk,tanggal,jenis_kegiatan,status&${filterSekolah}&tanggal=gte.${info.startStr}&tanggal=lte.${info.endStr}&jenis_kegiatan=eq.${j}&order=tanggal.asc,nuptk.asc`))
  ]);

  const umumByJenis = {};
  daftarJenis.forEach((j, i) => { umumByJenis[j] = umumPerJenis[i]; });

  // Peserta periode ini: sama persis dengan yang tampil di getRaporPeriode (aturan bawaan + penimpaan admin).
  const barisAda = await sbSelectAll(env, 'rapor_nilai', `select=nuptk&${filterSekolah}&periode=eq.${infoAsli.periode}&order=nuptk.asc,indikator_key.asc`);
  const adaNilai = new Set(barisAda.map((r) => String(r.nuptk).trim()));
  const ikutSet = new Set(daftarStafPeriodeRapor(cfg, users, infoAsli.periode, infoAsli.endStr, adaNilai).filter((d) => d.ikut).map((d) => d.nuptk));
  const roster = users.filter((u) => ikutSet.has(String(u.nuptk).trim()));
  const mapNilai = {}; (nilaiGuru || []).forEach((r) => { mapNilai[String(r.nuptk).trim()] = r; });
  const mapPay = {}; payroll.forEach((r) => { mapPay[String(r.nuptk).trim()] = r; });
  const mapJp = {}; jp.forEach((r) => { mapJp[String(r.nuptk).trim()] = r; });

  // Ringkasan baris kegiatan_umum per jenis -> per nuptk
  const umumPerGuru = (jenis) => {
    const m = {};
    (umumByJenis[jenis] || []).forEach((r) => {
      const n = String(r.nuptk).trim();
      if (!m[n]) m[n] = [];
      m[n].push(r);
    });
    return m;
  };
  const khususPerGuru = {};
  khusus.forEach((r) => {
    const n = String(r.nuptk).trim();
    if (!khususPerGuru[n]) khususPerGuru[n] = [];
    khususPerGuru[n].push(r);
  });

  // Acara pesantren: sesi (jenis + tanggal) yang dihadiri minimal sekian persen staf dianggap benar-benar diadakan.
  const persen = cfg.ambang_acara_persen || 20;
  const ambangAcara = Math.min(roster.length || 1, Math.max(2, Math.ceil((roster.length * persen) / 100)));
  const acaraPerJenis = {};
  const hitungAcara = (jenis) => {
    if (acaraPerJenis[jenis]) return acaraPerJenis[jenis];
    const hadirPerTanggal = {};
    (umumByJenis[jenis] || []).forEach((r) => {
      if (STATUS_PESANTREN_HADIR.includes(r.status)) hadirPerTanggal[r.tanggal] = (hadirPerTanggal[r.tanggal] || 0) + 1;
    });
    const set = new Set(Object.keys(hadirPerTanggal).filter((t) => hadirPerTanggal[t] >= ambangAcara));
    acaraPerJenis[jenis] = set;
    return set;
  };

  const bersihNama = (s) => String(s || '').trim().toLowerCase().split('(')[0].trim();
  const sekarang = new Date().toISOString();
  const baris = [];
  const dasar = (nuptk, key) => ({
    sekolah_id: sekolahId, periode: info.periode, nuptk, indikator_key: key,
    sumber: 'OTOMATIS', diisi_oleh: user.nama, diubah_pada: sekarang
  });
  const catatNilai = (nuptk, key, nilai, ket) => {
    baris.push(Object.assign(dasar(nuptk, key), { nilai: Math.min(10, Math.max(0, bulatkan2(nilai))), status: 'NILAI', keterangan: ket }));
  };
  const catatTB = (nuptk, key, ket) => {
    baris.push(Object.assign(dasar(nuptk, key), { nilai: null, status: 'TIDAK_BERLAKU', keterangan: ket }));
  };
  const gabungKet = (bagian) => bagian.filter(Boolean).join(', ');

  for (const u of roster) {
    const n = String(u.nuptk).trim();
    const pay = mapPay[n] || { hadir: 0, terlambat: 0, sakit: 0, izin: 0, tugasLuar: 0, alpa: 0, cuti: 0 };
    const jpRow = mapJp[n] || { terlambat: 0, sakit: 0, izin: 0, tugasLuar: 0, alpa: 0 };
    const hariHadir = pay.hadir + pay.terlambat;

    for (const ind of indikatorOto) {
      const k = ind.key;
      if (ind.aspek === 'B' && (u.kategori || 'Mengajar') !== 'Mengajar') continue;

      if (ind.sumber === 'KEHADIRAN') {
        const skor = mapNilai[n] ? mapNilai[n].skorKehadiran : null;
        if (skor === null || skor === undefined) { catatTB(n, k, 'Belum ada data absen pada periode ini'); continue; }
        const ket = gabungKet([
          pay.hadir ? `Hadir ${pay.hadir}` : '', pay.terlambat ? `terlambat ${pay.terlambat}` : '',
          pay.sakit ? `sakit/cuti ${pay.sakit}` : '', pay.izin ? `izin ${pay.izin}` : '',
          pay.tugasLuar ? `tugas dinas ${pay.tugasLuar}` : '', pay.alpa ? `tanpa keterangan ${pay.alpa}` : ''
        ]);
        catatNilai(n, k, skor / 10, ket);
      } else if (ind.sumber === 'KETEPATAN') {
        let tepat = pay.hadir, total = hariHadir, dariKhusus = 0;
        (khususPerGuru[n] || []).forEach((r) => {
          if (r.status_kehadiran === 'Hadir') { tepat++; total++; dariKhusus++; }
          else if (r.status_kehadiran === 'Terlambat') { total++; dariKhusus++; }
        });
        if (total === 0) { catatTB(n, k, 'Belum ada data kehadiran'); continue; }
        catatNilai(n, k, (tepat / total) * 10, `Tepat waktu ${tepat} dari ${total} kehadiran${dariKhusus ? ` (termasuk ${dariKhusus} kegiatan khusus)` : ''}`);
      } else if (ind.sumber === 'TAWASUL') {
        const baru = (umumPerGuru('BRIEFING_TAWASUL')[n] || []).filter((r) => r.status === 'Hadir');
        const hariTawasul = new Set(baru.map((r) => r.tanggal)).size;
        if (hariHadir === 0) { catatTB(n, k, 'Belum ada hari hadir'); continue; }
        catatNilai(n, k, (Math.min(hariTawasul, hariHadir) / hariHadir) * 10, `Ikut Tawasul ${Math.min(hariTawasul, hariHadir)} dari ${hariHadir} hari hadir`);
      } else if (ind.sumber === 'SHOLAT') {
        let sah = 0, total = 0;
        ['SHOLAT_DZUHUR', 'SHOLAT_ASHAR'].forEach((j) => {
          (umumPerGuru(j)[n] || []).forEach((r) => {
            if (STATUS_KEGIATAN_DIKECUALIKAN.includes(r.status)) return;
            total++;
            if (STATUS_SHOLAT_SAH.includes(r.status)) sah++;
          });
        });
        if (total === 0) { catatTB(n, k, 'Tidak ada data sholat pada periode ini'); continue; }
        catatNilai(n, k, (sah / total) * 10, `Sah ${sah} dari ${total} waktu wajib`);
      } else if (ind.sumber === 'PESANTREN') {
        const np = Object.assign({ majelis: 10, streaming: 7, berhalangan: 0 }, cfg.nilai_pesantren || {});
        let acara = 0, poin = 0, dikecualikan = 0, nM = 0, nS = 0, nB = 0;
        (ind.jenis || []).forEach((j) => {
          const sesi = hitungAcara(j);
          acara += sesi.size;
          (umumPerGuru(j)[n] || []).forEach((r) => {
            if (!sesi.has(r.tanggal)) return;
            if (r.status === 'Hadir di Majelis' || r.status === 'Hadir') { nM++; poin += Number(np.majelis); }
            else if (r.status === 'Hadir Streaming') { nS++; poin += Number(np.streaming); }
            else if (r.status === 'Berhalangan') { nB++; poin += Number(np.berhalangan); }
            else if (STATUS_KEGIATAN_DIKECUALIKAN.includes(r.status)) dikecualikan++;
          });
        });
        if (acara === 0) { catatTB(n, k, 'Tidak ada acara tercatat pada periode ini'); continue; }
        const penyebut = acara - dikecualikan;
        if (penyebut <= 0) { catatTB(n, k, 'Seluruh acara berstatus izin/sakit'); continue; }
        const ket = `Majelis ${nM}, streaming ${nS}, berhalangan ${nB} dari ${penyebut} acara`;
        catatNilai(n, k, Math.min(10, poin / penyebut), ket);
      } else if (ind.sumber === 'KEGIATAN_KHUSUS') {
        const kata = String(ind.kataKunci || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
        const agenda = jadwal.filter((a) => {
          if (!a.tanggal || a.tanggal < info.startStr || a.tanggal > info.endStr) return false;
          const nm = String(a.nama || '').toLowerCase();
          return kata.some((w) => nm.includes(w));
        });
        const diundang = agenda.filter((a) => (a.tipe_peserta || 'Semua GTK') !== 'Terbatas' || (a.daftar_peserta || []).map((x) => String(x).trim()).includes(n));
        if (diundang.length === 0) { catatTB(n, k, 'Tidak ada agenda pada periode ini'); continue; }
        let hadir = 0, dikecualikan = 0;
        diundang.forEach((a) => {
          const bersihA = bersihNama(a.nama);
          const row = (khususPerGuru[n] || []).find((r) => {
            if (r.tanggal_lapor !== a.tanggal) return false;
            const rn = bersihNama(r.nama_kegiatan);
            return rn === bersihA || rn.includes(bersihA);
          });
          if (!row) return;
          if (row.status_kehadiran === 'Hadir' || row.status_kehadiran === 'Terlambat') hadir++;
          else if (STATUS_KHUSUS_DIKECUALIKAN.includes(row.status_kehadiran)) dikecualikan++;
        });
        const penyebut = diundang.length - dikecualikan;
        if (penyebut <= 0) { catatTB(n, k, 'Seluruh agenda berstatus izin/sakit'); continue; }
        catatNilai(n, k, (hadir / penyebut) * 10, `Hadir ${hadir} dari ${penyebut} agenda`);
      }
    }

    // Blok Kehadiran Harian & KBM (angka murni untuk lembar rapor)
    const blok = {
      H_SAKIT: pay.sakit, H_IZIN_DINAS: pay.tugasLuar, H_IZIN: pay.izin, H_TK: pay.alpa, H_TERLAMBAT: pay.terlambat,
      K_SAKIT: jpRow.sakit, K_IZIN_DINAS: jpRow.tugasLuar, K_IZIN: jpRow.izin, K_TK: jpRow.alpa, K_TERLAMBAT: jpRow.terlambat
    };
    KEY_BLOK_KEHADIRAN.forEach((key) => {
      baris.push(Object.assign(dasar(n, key), { nilai: blok[key] || 0, status: 'NILAI', keterangan: null }));
    });
  }

  return { baris, jumlahGuru: roster.length, jumlahIndikatorOtomatis: indikatorOto.length, sebagian, akhirEfektif };
}

/** Simpan nilai manual (dan Teguran/Catatan). Kosong = belum dinilai; status TIDAK_BERLAKU = dikeluarkan dari rata-rata. */
async function simpanNilaiRapor(args, env) {
  const [token, periode, entries, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!user) return { success: false, message: 'Sesi habis, silakan login ulang.' };
  const sekolahId = sekolahIdRapor(user, requestedSekolahId);
  if (!sekolahId) return { success: false, message: 'Pilih sekolah dulu.' };
  const cfg = await bacaConfigRapor(env, sekolahId);
  if (!cfg || cfg.aktif === false) return { success: false, message: 'Rapor GTK belum diaktifkan untuk sekolah ini.' };
  const info = rentangPeriodeRapor(periode);
  if (!info) return { success: false, message: 'Periode tidak valid.' };
  if (!Array.isArray(entries) || entries.length === 0) return { success: true, message: 'Tidak ada perubahan untuk disimpan.', jumlah: 0 };
  if (entries.length > 3000) return { success: false, message: 'Terlalu banyak perubahan sekaligus (maksimal 3000 sel).' };

  const izin = hitungIzinRapor(user, cfg);
  const [periodeRow, users] = await Promise.all([
    ambilPeriodeRaporRow(env, sekolahId, info.periode, 'status'),
    getUsersListCached(env, sekolahId)
  ]);
  if (periodeRow && periodeRow.status === 'FINAL') {
    return { success: false, message: 'Rapor periode ini sudah difinalisasi dan terkunci.' };
  }

  const mapUser = {}; users.forEach((u) => { mapUser[String(u.nuptk).trim()] = u; });
  const mapInd = {}; (cfg.indikator || []).forEach((i) => { mapInd[i.key] = i; });
  const sekarang = new Date().toISOString();
  const upserts = [];
  const galat = [];

  for (const e of entries) {
    const nuptk = String(e.nuptk || '').trim();
    const key = String(e.key || '').trim();
    const u = mapUser[nuptk];
    if (!u) { galat.push(`Akun ${nuptk || '(kosong)'} tidak ditemukan`); continue; }
    const dasar = { sekolah_id: sekolahId, periode: info.periode, nuptk, indikator_key: key, sumber: 'MANUAL', diisi_oleh: user.nama, diubah_pada: sekarang };

    if (key === 'TEGURAN') {
      if (!izin.info) { galat.push('Anda tidak berhak mengisi Teguran'); continue; }
      const t = (e.nilai === '' || e.nilai === null || e.nilai === undefined) ? 0 : Number(e.nilai);
      if (!Number.isInteger(t) || t < 0 || t > 99) { galat.push(`Teguran ${u.nama} harus bilangan bulat 0 sampai 99`); continue; }
      upserts.push(Object.assign(dasar, { nilai: t, status: 'NILAI', keterangan: null }));
      continue;
    }
    if (key === 'CATATAN') {
      if (!izin.info) { galat.push('Anda tidak berhak mengisi Catatan'); continue; }
      upserts.push(Object.assign(dasar, { nilai: null, status: 'NILAI', keterangan: String(e.keterangan || '').trim().slice(0, 200) }));
      continue;
    }

    const ind = mapInd[key];
    if (!ind || ind.aktif === false) { galat.push(`Indikator ${key || '(kosong)'} tidak dikenal`); continue; }
    if (ind.sumber !== 'MANUAL') { galat.push(`"${ind.nama}" terisi otomatis dan tidak bisa diubah manual`); continue; }
    if (!izin[ind.aspek]) { galat.push(`Anda tidak berhak menilai aspek ${ASPEK_RAPOR[ind.aspek]}`); continue; }
    if (ind.aspek === 'B' && (u.kategori || 'Mengajar') !== 'Mengajar') continue;

    if (e.status === 'TIDAK_BERLAKU') {
      upserts.push(Object.assign(dasar, { nilai: null, status: 'TIDAK_BERLAKU', keterangan: null }));
    } else if (e.nilai === null || e.nilai === undefined || String(e.nilai).trim() === '') {
      upserts.push(Object.assign(dasar, { nilai: null, status: 'BELUM', keterangan: null }));
    } else {
      const v = Number(String(e.nilai).replace(',', '.'));
      if (!isFinite(v) || v < 0 || v > 10) { galat.push(`Nilai "${ind.nama}" untuk ${u.nama} harus 0 sampai 10`); continue; }
      upserts.push(Object.assign(dasar, { nilai: bulatkan2(v), status: 'NILAI', keterangan: null }));
    }
  }

  if (galat.length) {
    return { success: false, message: galat.slice(0, 3).join('; ') + (galat.length > 3 ? ` (dan ${galat.length - 3} lainnya)` : '') + '. Tidak ada yang disimpan.' };
  }
  await upsertBertahap(env, 'rapor_nilai', upserts, 'sekolah_id,periode,nuptk,indikator_key');
  return { success: true, jumlah: upserts.length, message: `${upserts.length} nilai tersimpan.` };
}

async function finalisasiRapor(args, env) {
  const [token, periode, paksa, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user) && !isRole(user, 'KEPALA_SEKOLAH')) return { success: false, message: 'Akses ditolak. Finalisasi khusus Admin dan Kepala Sekolah.' };
  const sekolahId = sekolahIdRapor(user, requestedSekolahId);
  if (!sekolahId) return { success: false, message: 'Pilih sekolah dulu.' };
  const cfg = await bacaConfigRapor(env, sekolahId);
  if (!cfg || cfg.aktif === false) return { success: false, message: 'Rapor GTK belum diaktifkan untuk sekolah ini.' };
  const info = rentangPeriodeRapor(periode);
  if (!info) return { success: false, message: 'Periode tidak valid.' };

  const periodeRow = await ambilPeriodeRaporRow(env, sekolahId, info.periode, 'status,otomatis_dihitung_pada');
  if (periodeRow && periodeRow.status === 'FINAL') return { success: false, message: 'Periode ini sudah difinalisasi.' };
  if (!periodeRow || !periodeRow.otomatis_dihitung_pada) {
    return { success: false, message: 'Jalankan "Hitung Nilai Otomatis" dulu sebelum finalisasi.' };
  }

  const [users, nilaiRows] = await Promise.all([
    getUsersListCached(env, sekolahId),
    sbSelectAll(env, 'rapor_nilai', `sekolah_id=eq.${encodeURIComponent(sekolahId)}&periode=eq.${info.periode}&order=nuptk.asc,indikator_key.asc`)
  ]);
  const guru = susunRaporPeriode(cfg, users, nilaiRows, info.periode, info.endStr);
  if (guru.length === 0) return { success: false, message: 'Tidak ada staf untuk dirapor pada periode ini.' };

  const totalBelum = guru.reduce((a, g) => a + g.jumlahBelum, 0);
  if (totalBelum > 0 && paksa !== true) {
    const daftar = guru.filter((g) => g.jumlahBelum > 0).slice(0, 8).map((g) => ({ nama: g.nama, jumlah: g.jumlahBelum }));
    return {
      success: false, butuhKonfirmasi: true, jumlahBelum: totalBelum,
      jumlahGuruBelum: guru.filter((g) => g.jumlahBelum > 0).length, contoh: daftar,
      message: `Masih ada ${totalBelum} nilai yang belum diisi.`
    };
  }

  const snapshot = {
    indikator: ringkasIndikatorRapor(cfg), ambang: cfg.ambang,
    titimangsa: { tempat: cfg.tempat_titimangsa || '', tanggal: tanggalTitimangsaRapor() },
    guru
  };
  await sbUpsertMany(env, 'rapor_periode', [{
    sekolah_id: sekolahId, periode: info.periode, tgl_mulai: info.startStr, tgl_selesai: info.endStr,
    status: 'FINAL', snapshot, difinalisasi_oleh: user.nama, difinalisasi_pada: new Date().toISOString()
  }], 'sekolah_id,periode');
  return { success: true, message: `Rapor ${info.label} difinalisasi untuk ${guru.length} orang dan kini terkunci.` };
}

async function bukaKembaliRapor(args, env) {
  const [token, periode, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user)) return { success: false, message: 'Akses ditolak. Hanya Admin yang bisa membuka kembali rapor.' };
  const sekolahId = sekolahIdRapor(user, requestedSekolahId);
  if (!sekolahId) return { success: false, message: 'Pilih sekolah dulu.' };
  const info = rentangPeriodeRapor(periode);
  if (!info) return { success: false, message: 'Periode tidak valid.' };

  const row = await ambilPeriodeRaporRow(env, sekolahId, info.periode, 'status');
  if (!row || row.status !== 'FINAL') return { success: false, message: 'Periode ini belum difinalisasi.' };
  await sbUpsertMany(env, 'rapor_periode', [{
    sekolah_id: sekolahId, periode: info.periode, status: 'DRAFT', snapshot: null, difinalisasi_oleh: null, difinalisasi_pada: null
  }], 'sekolah_id,periode');
  return { success: true, message: `Rapor ${info.label} dibuka kembali (Draft). Guru tidak bisa melihatnya sampai difinalisasi lagi.` };
}

/** Rapor milik sendiri (hanya periode yang sudah FINAL). */
async function getRaporSaya(args, env) {
  const [token, periode] = args;
  const user = await requireUser(env, token);
  if (!user) return { aktif: false };
  const sekolahId = user.sekolahId;
  if (!sekolahId) return { aktif: false };
  const cfg = await bacaConfigRapor(env, sekolahId);
  if (!cfg || cfg.aktif === false) return { aktif: false };

  const daftar = await sbSelect(env, 'rapor_periode', `select=periode&sekolah_id=eq.${encodeURIComponent(sekolahId)}&status=eq.FINAL&order=periode.desc&limit=36`);
  const daftarPeriode = daftar.map((d) => ({ periode: d.periode, label: labelPeriodeRapor(d.periode) }));
  if (daftarPeriode.length === 0) return { aktif: true, daftarPeriode: [], periode: null, rapor: null };

  const pilih = (periode && daftarPeriode.some((d) => d.periode === periode)) ? periode : daftarPeriode[0].periode;
  const row = await ambilPeriodeRaporRow(env, sekolahId, pilih, 'snapshot');
  const s = row && row.snapshot;
  const saya = s ? (s.guru || []).find((g) => String(g.nuptk).trim() === String(user.nuptk).trim()) : null;
  const info = rentangPeriodeRapor(pilih);
  return {
    aktif: true, daftarPeriode, periode: pilih, label: info.label, rentangLabel: info.rentangLabel,
    indikator: s ? s.indikator : [], aspek: ASPEK_RAPOR, ambang: s ? (s.ambang || cfg.ambang) : cfg.ambang,
    titimangsa: s ? s.titimangsa : null, rapor: saya || null
  };
}

/** Rerata beberapa periode (semester / tahun ajaran) dari rapor yang sudah FINAL. Khusus Admin & Kepala Sekolah. */
/** Atur siapa saja yang ikut dirapor pada satu periode (hanya Admin, hanya periode Draft). */
async function simpanPesertaRapor(args, env) {
  const [token, periode, daftarIkut, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user)) return { success: false, message: 'Akses ditolak.' };
  const sekolahId = sekolahIdRapor(user, requestedSekolahId);
  if (!sekolahId) return { success: false, message: 'Pilih sekolah dulu.' };
  const cfg = await bacaConfigRapor(env, sekolahId);
  if (!cfg || cfg.aktif === false) return { success: false, message: 'Rapor GTK belum diaktifkan untuk sekolah ini.' };
  const info = rentangPeriodeRapor(periode);
  if (!info) return { success: false, message: 'Periode tidak valid.' };
  if (!Array.isArray(daftarIkut)) return { success: false, message: 'Daftar peserta tidak valid.' };

  const periodeRow = await ambilPeriodeRaporRow(env, sekolahId, info.periode, 'status');
  if (periodeRow && periodeRow.status === 'FINAL') return { success: false, message: 'Periode ini sudah difinalisasi. Buka kembali dulu untuk mengubah peserta.' };

  const [users, nilaiRows] = await Promise.all([
    getUsersListCached(env, sekolahId),
    sbSelectAll(env, 'rapor_nilai', `select=nuptk&sekolah_id=eq.${encodeURIComponent(sekolahId)}&periode=eq.${info.periode}&order=nuptk.asc,indikator_key.asc`)
  ]);
  const adaNilai = new Set(nilaiRows.map((r) => String(r.nuptk).trim()));
  const mau = new Set(daftarIkut.map((x) => String(x).trim()));
  const tambah = [], keluar = [];
  daftarStafPeriodeRapor(cfg, users, info.periode, info.endStr, adaNilai).forEach((d) => {
    const ingin = mau.has(d.nuptk);
    if (ingin && !d.bawaan) tambah.push(d.nuptk);
    else if (!ingin && d.bawaan) keluar.push(d.nuptk);
  });

  cfg.peserta = cfg.peserta || {};
  if (tambah.length === 0 && keluar.length === 0) delete cfg.peserta[info.periode];
  else cfg.peserta[info.periode] = { tambah, keluar };
  // Simpan paling banyak 36 periode terakhir supaya konfigurasi tidak membengkak.
  Object.keys(cfg.peserta).sort().slice(0, Math.max(0, Object.keys(cfg.peserta).length - 36)).forEach((k) => delete cfg.peserta[k]);
  await tulisConfigRapor(env, sekolahId, cfg);
  return { success: true, message: `Peserta rapor ${info.label} disimpan (${mau.size} orang). Jalankan "Hitung Nilai Otomatis" lagi agar nilai orang yang baru ditambahkan terisi.` };
}

async function getRaporRerata(args, env) {
  const [token, periodeAwal, periodeAkhir, requestedSekolahId] = args;
  const user = await requireUser(env, token);
  if (!isAdminAny(user) && !isRole(user, 'KEPALA_SEKOLAH')) return { success: false, message: 'Akses ditolak.' };
  const sekolahId = sekolahIdRapor(user, requestedSekolahId);
  if (!sekolahId) return { success: false, message: 'Pilih sekolah dulu.' };
  const cfg = await bacaConfigRapor(env, sekolahId);
  if (!cfg || cfg.aktif === false) return { success: false, message: 'Rapor GTK belum diaktifkan untuk sekolah ini.' };
  const a = rentangPeriodeRapor(periodeAwal), b = rentangPeriodeRapor(periodeAkhir);
  if (!a || !b || a.periode > b.periode) return { success: false, message: 'Rentang periode tidak valid.' };

  const rows = await sbSelect(env, 'rapor_periode',
    `select=periode,snapshot&sekolah_id=eq.${encodeURIComponent(sekolahId)}&status=eq.FINAL&periode=gte.${a.periode}&periode=lte.${b.periode}&order=periode.asc&limit=24`);
  if (rows.length === 0) return { success: true, periodeList: [], guru: [], message: 'Belum ada rapor FINAL pada rentang ini.' };

  const peta = {};
  rows.forEach((r) => {
    ((r.snapshot && r.snapshot.guru) || []).forEach((g) => {
      const n = String(g.nuptk).trim();
      if (!peta[n]) peta[n] = { nuptk: n, nama: g.nama, jabatan: g.jabatan || '', rataPerPeriode: {} };
      peta[n].nama = g.nama;
      if (g.jabatan) peta[n].jabatan = g.jabatan;
      if (g.rata !== null && g.rata !== undefined) peta[n].rataPerPeriode[r.periode] = g.rata;
    });
  });
  const ambang = (rows[rows.length - 1].snapshot && rows[rows.length - 1].snapshot.ambang) || cfg.ambang;
  const guru = Object.values(peta).map((g) => {
    const nilai = Object.values(g.rataPerPeriode);
    const rerata = nilai.length ? bulatkan2(nilai.reduce((x, y) => x + y, 0) / nilai.length) : null;
    return Object.assign(g, { jumlahPeriode: nilai.length, rerata, predikat: predikatRapor(rerata, ambang) });
  }).sort((x, y) => (y.rerata === null ? -1 : y.rerata) - (x.rerata === null ? -1 : x.rerata));
  guru.forEach((g, i) => { g.peringkat = i + 1; });

  return {
    success: true,
    periodeList: rows.map((r) => ({ periode: r.periode, label: labelPeriodeRapor(r.periode) })),
    guru
  };
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
  changePassword,
  getSekolahList,
  getLokasiAbsenTarget,
  saveAbsenMasuk,
  getStatusAbsenHariIni,
  saveAbsenPulang,
  getDashboardCharts,
  getAbsenMasukUntukEdit,
  updateAbsenMasuk,
  uploadGambarIdentitas,
  hapusGambarIdentitas,
  checkSudahAbsenKegiatan,
  saveKegiatan,
  saveAbsenKegiatanKhusus,
  tutupAbsenKegiatan,
  saveJadwalKegiatan,
  getJadwalKegiatan,
  toggleStatusKegiatan,
  deleteJadwalKegiatan,
  getDashboardData,
  getAturanPenilaian,
  saveAturanPenilaian,
  getSettingsData,
  getIdentitasSekolahUntukCetak,
  saveSettingsData,
  jalankanAutoAlpaManual,
  jalankanAutoSholatManual,
  getUsers,
  saveUser,
  updateUser,
  changeUsername,
  getGuruList,
  getGuruMengajarList,
  getRiwayatAktivitas,
  deleteUser,
  setStatusUser,
  getStafAktifUntukImpal,
  saveHariLibur,
  getLiburList,
  deleteHariLibur,
  saveCutiGuru,
  getCutiList,
  deleteCutiGuru,
  getPayrollReport,
  getReport,
  getRekapAbsenMasukSendiri,
  getRekapJamPelajaranSendiri,
  getGambarDataUri,
  getPayrollJamPelajaran,
  saveRekapJamPelajaran,
  getRekapJamPelajaranList,
  updateRekapJamPelajaran,
  deleteRekapJamPelajaran,
  getNilaiGuru,
  getRaporConfig,
  aktifkanRapor,
  simpanRaporConfig,
  getRaporPeriode,
  hitungRaporOtomatis,
  simpanNilaiRapor,
  finalisasiRapor,
  bukaKembaliRapor,
  getRaporSaya,
  getRaporRerata,
  simpanPesertaRapor,
  simpanTokenFCM,
  kirimNotifikasiAdmin
};
