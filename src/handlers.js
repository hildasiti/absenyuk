import { sbSelect, sbInsert, sbUpdate, sbDelete } from './supabase.js';
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

async function getUsersListCached(env) {
  return cached(env, 'USERS_CACHE', 180, () => sbSelect(env, 'users'));
}
async function getLiburListCached(env) {
  return cached(env, 'LIBUR_CACHE', 600, () => sbSelect(env, 'libur_nasional'));
}
async function getJadwalKegiatanCached(env) {
  return cached(env, 'JADWAL_KEGIATAN_CACHE', 60, () => sbSelect(env, 'jadwal_kegiatan'));
}

// Konfigurasi jenis laporan/kegiatan (8 jenis majelis/kegiatan rutin yang identik strukturnya).
const KEGIATAN_IDENTIK = [
  'BRIEFING_TAWASUL', 'PENDAMPINGAN_DHUHA', 'SHOLAT_DZUHUR', 'SHOLAT_ASHAR',
  'DZIKIR_MAKHSUS', 'PENGAJIAN_AHAD', 'PENGAJIAN_ARBAIN', 'QINI_NASIONAL'
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

  const userObj = {
    id: userRow.legacy_id, nuptk: userRow.nuptk, nama: userRow.nama,
    role: String(userRow.role).trim().toUpperCase().replace(/\s+/g, '_'),
    kategori: userRow.kategori || 'Mengajar'
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
// ABSEN MASUK
// ====================================================================

async function saveAbsenMasuk(args, env) {
  const [token, status, keterangan, lat, lon] = args;
  const user = await requireUser(env, token);
  if (!user) return { success: false, message: 'Sesi habis, silakan login ulang.' };

  const { dateStr, timeStr: jamLaporStr, dayOfWeek } = nowJakarta();

  let statusLiburSistem = '';
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    statusLiburSistem = 'Libur Akhir Pekan';
  } else {
    const namaLiburNasional = await checkApakahHariLibur(env, dateStr);
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

  const settings = await getSettingsMap(env);
  let finalStatus = status;
  const mapsLink = `https://www.google.com/maps?q=${lat},${lon}`;
  const jarakMeter = hitungRadiusGPS(parseFloat(lat), parseFloat(lon), parseFloat(settings.lat_sekolah), parseFloat(settings.long_sekolah));

  if (status === 'Hadir') {
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
      id: generateShortID('AB'), tanggal: dateStr, nuptk: user.nuptk, nama: user.nama,
      jam: jamLaporStr, latitude: String(lat), longitude: String(lon), jarak: jarakMeter + ' m',
      status: finalStatus, keterangan: keterangan || '-', maps_link: mapsLink
    });
  } catch (err) {
    if (String(err.message).includes('duplicate key')) {
      return { success: false, message: 'Anda sudah melakukan presensi masuk hari ini.' };
    }
    throw err;
  }
  await invalidate(env, 'ABSEN_MASUK_PERIODE_CACHE');

  let pesanSukses = `Presensi berhasil disimpan pada pukul ${jamLaporStr} WIB.`;
  switch (finalStatus) {
    case 'Hadir': pesanSukses += ' Terimakasih Telah Tepat Waktu. Semoga Allah Lancarkan Kegiatan hari ini!'; break;
    case 'Terlambat': pesanSukses = 'Mari datang lebih pagi untuk menyambut siswa. Jam Absen ' + jamLaporStr + ' WIB.'; break;
    case 'Sakit': pesanSukses += ' Semoga lekas sembuh, Pak/Bu. Jangan lupa konfirmasi Kepala Sekolah.'; break;
    case 'Izin': pesanSukses += ' Terima kasih atas informasinya, jangan lupa konfirmasi Kepala Sekolah.'; break;
    case 'Tugas Luar': pesanSukses += ' Selamat melaksanakan tugas di luar sekolah!'; break;
    default: pesanSukses += ' Data Anda telah terekam di sistem.';
  }
  return { success: true, message: pesanSukses };
}

async function getAbsenMasukUntukEdit(args, env) {
  const [token, tanggal, filterNuptk] = args;
  const user = await requireUser(env, token);
  if (!user || user.role !== 'ADMIN') return [];

  const dateStr = tanggal || nowJakarta().dateStr;
  const rows = await sbSelect(env, 'absen_masuk', `tanggal=eq.${dateStr}`);
  const filterTarget = String(filterNuptk || 'ALL').trim();

  return rows
    .filter((r) => filterTarget === 'ALL' || String(r.nuptk).trim() === filterTarget)
    .sort((a, b) => String(a.jam).localeCompare(String(b.jam)))
    .map((r) => ({ docId: r.id, nuptk: r.nuptk, nama: r.nama, tanggal: r.tanggal, jam: r.jam, status: r.status, keterangan: r.keterangan }));
}

async function updateAbsenMasuk(args, env) {
  const [token, docId, jamBaru, statusBaru, keteranganBaru] = args;
  const user = await requireUser(env, token);
  if (!user || user.role !== 'ADMIN') return { success: false, message: 'Akses ditolak. Hanya Admin yang bisa mengubah data absen.' };
  if (!docId) return { success: false, message: 'Data absen tidak ditemukan (docId kosong).' };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(jamBaru).trim())) {
    return { success: false, message: 'Format jam tidak valid. Gunakan format HH:mm, contoh 07:15.' };
  }
  if (!STATUS_ABSEN_VALID.includes(statusBaru)) return { success: false, message: 'Status tidak dikenal: ' + statusBaru };

  const rows = await sbSelect(env, 'absen_masuk', `id=eq.${encodeURIComponent(docId)}&limit=1`);
  const existing = rows[0];
  if (!existing) return { success: false, message: 'Data absen tidak ditemukan di database (mungkin sudah dihapus).' };

  await sbUpdate(env, 'absen_masuk', 'id', docId, {
    jam: String(jamBaru).trim(), status: statusBaru, keterangan: keteranganBaru || '-'
  });
  await invalidate(env, 'ABSEN_MASUK_PERIODE_CACHE');
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
  let query = `nuptk=eq.${encodeURIComponent(user.nuptk)}&${config.dateField}=eq.${dateStr}`;
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

  if (status === 'Hadir di Majelis') {
    const settings = await getSettingsMap(env);
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
    id: generateShortID('K'), jenis_kegiatan: sheetName, tanggal: dateStr, nuptk: user.nuptk, nama: user.nama,
    kegiatan, status, catatan: catatan || '-', timestamp: new Date().toISOString()
  });
  return { success: true, message: 'Data kehadiran majelis berhasil disimpan.' };
}

async function saveAbsenKegiatanKhusus(args, env) {
  const [token, namaKegiatanStr, statusKehadiran, catatan, lat, lon] = args;
  const user = await requireUser(env, token);
  if (!user) return { success: false, message: 'Sesi habis, silakan login ulang.' };

  const { dateStr, timeStr: jamLaporStr } = nowJakarta();
  const inputCleanKegNama = String(namaKegiatanStr).trim().toLowerCase();

  const existing = await sbSelect(env, 'absen_kegiatan_khusus', `nuptk=eq.${encodeURIComponent(user.nuptk)}&tanggal_lapor=eq.${dateStr}`);
  const sudah = existing.some((r) => String(r.nama_kegiatan).trim().toLowerCase() === inputCleanKegNama);
  if (sudah) {
    return { success: false, message: `Ditolak! Anda sudah melakukan presensi untuk kegiatan "${namaKegiatanStr}" hari ini.` };
  }

  let finalStatus = statusKehadiran;
  let waktuKegiatanStr = '', toleransiMenit = 15, latKegiatan = '', lonKegiatan = '', radiusKegiatan = 50;

  const dataJadwal = await getJadwalKegiatanCached(env);
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
    id: generateShortID('AK'), tanggal_lapor: dateStr, waktu_lapor: jamLaporStr, nuptk: user.nuptk,
    nama: user.nama, nama_kegiatan: namaKegiatanStr, status_kehadiran: finalStatus,
    catatan: catatan || '', latitude: lat || '-', longitude: lon || '-', jarak: jarakTercatat
  });

  return { success: true, message: `Absensi disimpan pada pukul ${jamLaporStr} WIB.` };
}

async function tutupAbsenKegiatan(args, env) {
  const [token, kegiatanId] = args;
  const user = await requireUser(env, token);
  if (!isRole(user, 'ADMIN', 'KEPALA_SEKOLAH')) return { success: false, message: 'Akses ditolak.' };

  const rows = await sbSelect(env, 'jadwal_kegiatan', `id=eq.${encodeURIComponent(kegiatanId)}&limit=1`);
  const keg = rows[0];
  if (!keg) return { success: false, message: 'Kegiatan tidak ditemukan (mungkin sudah dihapus).' };

  const jamSekarangStr = nowJakarta().timeStr;
  const tanggalKeg = keg.tanggal;
  const cleanKegNama = String(keg.nama).trim().toLowerCase().split('(')[0].trim();

  const absenKegIni = await sbSelect(env, 'absen_kegiatan_khusus', `tanggal_lapor=eq.${tanggalKeg}`);
  const sudahAbsen = absenKegIni
    .filter((r) => {
      const rowKeg = String(r.nama_kegiatan).trim().toLowerCase().split('(')[0].trim();
      return rowKeg === cleanKegNama || rowKeg.includes(cleanKegNama);
    })
    .map((r) => String(r.nuptk).trim());

  const users = await getUsersListCached(env);
  const kegTipePeserta = keg.tipe_peserta || 'Semua GTK';
  const kegDaftarPeserta = keg.daftar_peserta || [];
  let jumlahDitandai = 0;

  for (const u of users) {
    const userNuptk = String(u.nuptk).trim();
    const userRole = String(u.role).trim();
    const userStatus = String(u.status).trim();
    if (['GURU', 'KEPALA_SEKOLAH', 'PIKET'].includes(userRole) && userStatus === 'Aktif') {
      const diundang = kegTipePeserta !== 'Terbatas' || kegDaftarPeserta.includes(userNuptk);
      if (diundang && !sudahAbsen.includes(userNuptk)) {
        await sbInsert(env, 'absen_kegiatan_khusus', {
          id: generateShortID('AK'), tanggal_lapor: tanggalKeg, waktu_lapor: jamSekarangStr, nuptk: userNuptk,
          nama: u.nama, nama_kegiatan: keg.nama, status_kehadiran: 'Tanpa Keterangan',
          catatan: 'Tidak Absen (Absen Ditutup Admin)', latitude: '-', longitude: '-', jarak: '-'
        });
        jumlahDitandai++;
      }
    }
  }

  await sbUpdate(env, 'jadwal_kegiatan', 'id', kegiatanId, { status: 'Nonaktif' });
  await invalidate(env, 'JADWAL_KEGIATAN_CACHE');

  return { success: true, message: `Absen "${keg.nama}" ditutup. ${jumlahDitandai} peserta yang belum absen ditandai Tanpa Keterangan.` };
}

// ====================================================================
// JADWAL KEGIATAN (agenda/rapat)
// ====================================================================

async function saveJadwalKegiatan(args, env) {
  const [token, namaKegiatan, tanggal, waktu, toleransi, tipePeserta, daftarNuptkPeserta, lat, lon, radiusMeter] = args;
  const user = await requireUser(env, token);
  if (!isRole(user, 'ADMIN')) return { success: false, message: 'Akses ditolak.' };

  const id = generateShortID('JK');
  const tipe = tipePeserta === 'Terbatas' ? 'Terbatas' : 'Semua GTK';
  const daftarArr = tipe === 'Terbatas' && Array.isArray(daftarNuptkPeserta) ? daftarNuptkPeserta : [];
  if (tipe === 'Terbatas' && daftarArr.length === 0) {
    return { success: false, message: 'Pilih minimal 1 peserta untuk rapat terbatas.' };
  }

  await sbInsert(env, 'jadwal_kegiatan', {
    id, nama: namaKegiatan, tanggal, waktu, status: 'Aktif',
    toleransi: toleransi ? parseInt(toleransi, 10) : 15, tipe_peserta: tipe,
    daftar_peserta: daftarArr,
    lat: lat !== undefined && lat !== null && lat !== '' ? parseFloat(lat) : null,
    lon: lon !== undefined && lon !== null && lon !== '' ? parseFloat(lon) : null,
    radius: radiusMeter ? parseInt(radiusMeter, 10) : 50
  });
  await invalidate(env, 'JADWAL_KEGIATAN_CACHE');
  return { success: true, message: 'Jadwal kegiatan berhasil ditambahkan!' };
}

async function getJadwalKegiatan(args, env) {
  const [token] = args;
  if (!(await requireUser(env, token))) return [];
  const result = await getJadwalKegiatanCached(env);

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
  if (!isRole(user, 'ADMIN')) return { success: false, message: 'Akses ditolak.' };
  const statusBaru = statusSekarang === 'Aktif' ? 'Nonaktif' : 'Aktif';
  await sbUpdate(env, 'jadwal_kegiatan', 'id', String(idAtauRow).trim(), { status: statusBaru });
  await invalidate(env, 'JADWAL_KEGIATAN_CACHE');
  return { success: true, message: `Status kegiatan berhasil diubah menjadi [${statusBaru}].` };
}

async function deleteJadwalKegiatan(args, env) {
  const [token, idAtauRow] = args;
  const user = await requireUser(env, token);
  if (!isRole(user, 'ADMIN')) return { success: false, message: 'Akses ditolak.' };
  await sbDelete(env, 'jadwal_kegiatan', 'id', String(idAtauRow).trim());
  await invalidate(env, 'JADWAL_KEGIATAN_CACHE');
  return { success: true, message: 'Jadwal kegiatan berhasil dihapus.' };
}

// ====================================================================
// DASHBOARD
// ====================================================================

async function getDashboardData(args, env) {
  const [token, startDate, endDate] = args;
  const user = await requireUser(env, token);
  if (!user) return null;

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
    const statusLibur = await checkApakahHariLibur(env, dateStr);
    if (statusLibur) { data.todayStatus = 'Libur: ' + statusLibur; apakahHariLibur = true; }
  }

  const users = await getUsersListCached(env);
  data.totalGuru = users.filter((u) => ['GURU', 'KEPALA_SEKOLAH', 'PIKET'].includes(String(u.role).trim()) && String(u.status).trim() === 'Aktif').length;

  let sDate, eDate;
  if (startDate && endDate) {
    sDate = new Date(startDate); eDate = new Date(endDate);
  } else {
    sDate = mingguIni.start; eDate = mingguIni.end;
  }
  const sDateStr = toDateStr(sDate);
  const eDateStr = toDateStr(eDate);

  const sheetMasuk = await sbSelect(env, 'absen_masuk', `tanggal=gte.${sDateStr}&tanggal=lte.${eDateStr}`);

  let sudahAbsenHariIni = [];
  let statusGuruHariIni = {};

  sheetMasuk.forEach((row) => {
    const rowDateStr = row.tanggal;
    const statusAbsen = String(row.status).trim();
    const namaGuru = String(row.nama).trim();
    const nuptkGuru = String(row.nuptk).trim();

    if (['ADMIN', 'PIKET', 'KEPALA_SEKOLAH'].includes(user.role)) {
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
    if (['GURU', 'KEPALA_SEKOLAH', 'PIKET'].includes(uRole) && uStatus === 'Aktif') {
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
  const [token] = args;
  const user = await requireUser(env, token);
  if (!isRole(user, 'ADMIN', 'PIKET')) return {};
  return getSettingsMap(env);
}

async function saveSettingsData(args, env) {
  const [token, config] = args;
  const user = await requireUser(env, token);
  if (!isRole(user, 'ADMIN')) return false;

  for (const key of Object.keys(config)) {
    if (config[key] !== undefined) {
      const existingRows = await sbSelect(env, 'settings', `key=eq.${encodeURIComponent(key)}&limit=1`);
      if (existingRows.length > 0) {
        await sbUpdate(env, 'settings', 'key', key, { value: String(config[key]) });
      } else {
        await sbInsert(env, 'settings', { key, value: String(config[key]) });
      }
    }
  }
  await invalidate(env, 'SETTINGS_CACHE');
  return true;
}

// ====================================================================
// USERS / GURU
// ====================================================================

async function getUsers(args, env) {
  const [token] = args;
  const user = await requireUser(env, token);
  if (!isRole(user, 'ADMIN')) return [];
  const result = await getUsersListCached(env);
  return result.map((u) => ({ id: u.legacy_id, nuptk: u.nuptk, nama: u.nama, email: u.email, role: u.role, status: u.status, kategori: u.kategori || 'Mengajar' }));
}

async function saveUser(args, env) {
  const [token, userData] = args;
  const user = await requireUser(env, token);
  if (!isRole(user, 'ADMIN')) return false;

  const nuptk = String(userData.nuptk).trim();
  await sbInsert(env, 'users', {
    nuptk, legacy_id: generateShortID('U'), nama: userData.nama, email: userData.email,
    password: userData.password, role: userData.role, status: 'Aktif',
    created_at: new Date().toISOString(), kategori: userData.kategori || 'Mengajar'
  });
  await invalidate(env, 'USERS_CACHE');
  return true;
}

async function getGuruList(args, env) {
  const [token] = args;
  const user = await requireUser(env, token);
  if (!isRole(user, 'ADMIN', 'PIKET', 'KEPALA_SEKOLAH')) return [];
  const result = await getUsersListCached(env);
  return result.filter((u) => String(u.role).trim() !== 'ADMIN')
    .map((u) => ({ id: u.legacy_id, nuptk: u.nuptk, nama: u.nama, status: u.status, role: u.role, row: u.nuptk }));
}

async function getGuruMengajarList(args, env) {
  const [token] = args;
  const user = await requireUser(env, token);
  if (!isRole(user, 'ADMIN', 'PIKET', 'KEPALA_SEKOLAH')) return [];
  const result = await getUsersListCached(env);
  return result.filter((u) => (u.kategori || 'Mengajar') === 'Mengajar' && String(u.role).trim() !== 'ADMIN')
    .map((u) => ({ id: u.legacy_id, nuptk: u.nuptk, nama: u.nama, status: u.status, role: u.role, row: u.nuptk }));
}

async function deleteUser(args, env) {
  const [token, nuptkAtauRow] = args;
  const user = await requireUser(env, token);
  if (!isRole(user, 'ADMIN')) return { success: false, message: 'Akses ditolak. Anda bukan Admin.' };
  await sbDelete(env, 'users', 'nuptk', String(nuptkAtauRow).trim());
  await invalidate(env, 'USERS_CACHE');
  return { success: true, message: 'Data pendidik berhasil dihapus dari sistem.' };
}

async function getStafAktifUntukImpal(args, env) {
  const [token] = args;
  const user = await requireUser(env, token);
  if (!isRole(user, 'ADMIN', 'PIKET', 'KEPALA_SEKOLAH')) return [];
  const users = await getUsersListCached(env);
  return users.filter((u) => String(u.status).trim() === 'Aktif' && String(u.role).trim() !== 'ADMIN')
    .map((u) => ({ nuptk: u.nuptk, nama: u.nama, role: u.role, kategori: u.kategori || 'Mengajar' }));
}

// ====================================================================
// LIBUR NASIONAL
// ====================================================================

async function saveHariLibur(args, env) {
  const [token, tglMulai, tglSelesai, keterangan] = args;
  const user = await requireUser(env, token);
  if (!isRole(user, 'ADMIN')) return { success: false, message: 'Akses ditolak.' };
  if (new Date(tglMulai) > new Date(tglSelesai)) {
    return { success: false, message: 'Tanggal mulai tidak boleh melebihi tanggal selesai libur!' };
  }
  const id = generateShortID('L');
  await sbInsert(env, 'libur_nasional', { id, tgl_mulai: tglMulai, tgl_selesai: tglSelesai, keterangan });
  await invalidate(env, 'LIBUR_CACHE');
  return { success: true, message: 'Rentang hari libur sekolah berhasil dijadwalkan!' };
}

async function getLiburList(args, env) {
  const [token] = args;
  const user = await requireUser(env, token);
  if (!isRole(user, 'ADMIN', 'PIKET')) return [];
  const result = await getLiburListCached(env);
  return result.map((l) => ({ id: l.id, tglMulai: l.tgl_mulai, tglSelesai: l.tgl_selesai, keterangan: l.keterangan, row: l.id }));
}

async function deleteHariLibur(args, env) {
  const [token, idAtauRow] = args;
  const user = await requireUser(env, token);
  if (!isRole(user, 'ADMIN')) return { success: false, message: 'Akses ditolak.' };
  await sbDelete(env, 'libur_nasional', 'id', String(idAtauRow).trim());
  await invalidate(env, 'LIBUR_CACHE');
  return { success: true, message: 'Hari libur berhasil dihapus.' };
}

// ====================================================================
// LAPORAN / PAYROLL
// ====================================================================

async function getPayrollReport(args, env) {
  const [token, startDate, endDate] = args;
  const user = await requireUser(env, token);
  if (!isRole(user, 'ADMIN', 'PIKET', 'KEPALA_SEKOLAH')) return [];

  const sDateStr = toDateStr(new Date(startDate));
  const eDateStr = toDateStr(new Date(endDate));

  const users = await getUsersListCached(env);
  const payrollMap = {};
  users.forEach((u) => {
    if (['GURU', 'KEPALA_SEKOLAH', 'PIKET'].includes(String(u.role).trim()) && String(u.status).trim() === 'Aktif') {
      payrollMap[u.nuptk] = { nuptk: u.nuptk, nama: u.nama, hadir: 0, terlambat: 0, sakit: 0, izin: 0, tugasLuar: 0, alpa: 0 };
    }
  });

  const rows = await sbSelect(env, 'absen_masuk', `tanggal=gte.${sDateStr}&tanggal=lte.${eDateStr}`);
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
  const [token, startDate, endDate, type, filterNuptk] = args;
  const user = await requireUser(env, token);
  if (!isRole(user, 'ADMIN', 'PIKET', 'KEPALA_SEKOLAH')) return [];

  const config = REPORT_CONFIG[type];
  if (!config) return { headers: [], data: [] };

  const sDateStr = toDateStr(new Date(startDate));
  const eDateStr = toDateStr(new Date(endDate));

  let query = `${config.dateField}=gte.${sDateStr}&${config.dateField}=lte.${eDateStr}`;
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

  const periodeBerjalan = getPeriodeBerjalan();
  let sDate, eDate, periodeLabel;
  if (startDate && endDate) {
    sDate = new Date(startDate); eDate = new Date(endDate);
    periodeLabel = `${sDate.getDate()}/${sDate.getMonth() + 1}/${sDate.getFullYear()} - ${eDate.getDate()}/${eDate.getMonth() + 1}/${eDate.getFullYear()}`;
  } else {
    sDate = periodeBerjalan.start; eDate = periodeBerjalan.end; periodeLabel = periodeBerjalan.label;
  }

  const rows = await sbSelect(env, 'rekap_jam_pelajaran', `tanggal=gte.${toDateStr(sDate)}&tanggal=lte.${toDateStr(eDate)}`);
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
  const [token, startDate, endDate] = args;
  const user = await requireUser(env, token);
  if (!isRole(user, 'ADMIN', 'PIKET', 'KEPALA_SEKOLAH')) return [];

  const rows = await sbSelect(env, 'rekap_jam_pelajaran', `tanggal=gte.${toDateStr(new Date(startDate))}&tanggal=lte.${toDateStr(new Date(endDate))}`);
  const users = await getUsersListCached(env);
  const rekapMap = {};
  users.forEach((u) => {
    if (['GURU', 'KEPALA_SEKOLAH', 'PIKET'].includes(String(u.role).trim()) && String(u.status).trim() === 'Aktif') {
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
  if (!isRole(user, 'ADMIN', 'PIKET')) return { success: false, message: 'Akses ditolak. Fitur ini khusus Piket/Admin.' };
  if (!Array.isArray(jamKeArray) || jamKeArray.length === 0) return { success: false, message: 'Pilih minimal 1 Jam Pelajaran.' };

  const timestamp = new Date().toISOString();
  const jamTerurut = jamKeArray.slice().sort((a, b) => Number(a) - Number(b));

  for (const jam of jamTerurut) {
    await sbInsert(env, 'rekap_jam_pelajaran', {
      id: generateShortID('JP'), tanggal, nuptk: nuptkGuru, nama_guru: namaGuru, jam_ke: 'JP ' + jam,
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
  await invalidate(env, 'USERS_CACHE');
  return { success: true, message: 'Token berhasil diupdate.' };
}

/** Dipanggil dari Cron Trigger (07:20 WIB). Tidak dipanggil dari frontend. */
export async function cekDanKirimNotifikasiBelumAbsen(env) {
  const { dateStr, dayOfWeek } = nowJakarta();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    console.log('Akhir pekan, sistem libur.');
    return;
  }

  const statusLibur = await checkApakahHariLibur(env, dateStr);
  if (statusLibur) {
    console.log('Hari ini libur: ' + statusLibur + '. Notifikasi dibatalkan.');
    return;
  }

  const users = await getUsersListCached(env);
  const absenHariIni = await sbSelect(env, 'absen_masuk', `tanggal=eq.${dateStr}`);
  const sudahAbsenNuptk = absenHariIni.map((r) => String(r.nuptk).trim());

  let jumlahDikirim = 0;
  for (const u of users) {
    const uRole = String(u.role).trim(), uStatus = String(u.status).trim(), uNuptk = String(u.nuptk).trim();
    const fcmToken = u.fcm_token;
    if (['GURU', 'KEPALA_SEKOLAH', 'PIKET'].includes(uRole) && uStatus === 'Aktif') {
      if (!sudahAbsenNuptk.includes(uNuptk) && fcmToken) {
        const judul = 'Pengingat Presensi Masuk ⏱️';
        const pesan = `Halo ${u.nama}, waktu sudah menunjukkan pukul 07.20 WIB. Mari segera lakukan presensi masuk sebelum terlambat!`;
        await kirimNotifikasiKeSatuHP(env, fcmToken, judul, pesan);
        jumlahDikirim++;
      }
    }
  }
  console.log(`Selesai! Notifikasi pengingat dikirim ke ${jumlahDikirim} GTK yang belum absen.`);
}

/** Dipanggil dari Cron Trigger (12:00 WIB). Tidak dipanggil dari frontend. */
export async function autoSetTanpaKeterangan(env) {
  const settings = await getSettingsMap(env);
  if ((settings.status_auto_alpa || 'Aktif') === 'Nonaktif') {
    console.log('Sistem Auto Alpa Presensi Masuk dihentikan karena fitur di-Nonaktifkan sementara oleh Admin.');
    return;
  }

  const { dateStr, dayOfWeek } = nowJakarta();
  if (dayOfWeek === 0 || dayOfWeek === 6) return;

  const statusLibur = await checkApakahHariLibur(env, dateStr);
  if (statusLibur) return;

  const users = await getUsersListCached(env);
  const absenHariIni = await sbSelect(env, 'absen_masuk', `tanggal=eq.${dateStr}`);
  const sudahAbsenHariIni = absenHariIni.map((r) => String(r.nuptk).trim());

  for (const u of users) {
    const userRole = String(u.role).trim(), userStatus = String(u.status).trim();
    const userNuptk = String(u.nuptk).trim(), userNama = String(u.nama).trim();

    if (['GURU', 'KEPALA_SEKOLAH', 'PIKET'].includes(userRole) && userStatus === 'Aktif') {
      if (!sudahAbsenHariIni.includes(userNuptk)) {
        try {
          await sbInsert(env, 'absen_masuk', {
            id: generateShortID('AO'), tanggal: dateStr, nuptk: userNuptk, nama: userNama,
            jam: '--:--', latitude: '-', longitude: '-', jarak: 'xx m',
            status: 'Tanpa Keterangan', keterangan: 'Tidak Absen!', maps_link: '-'
          });
        } catch (err) {
          // race condition (mis. guru absen manual persis saat cron jalan) - lewati saja
          if (!String(err.message).includes('duplicate key')) throw err;
        }
      }
    }
  }
  await invalidate(env, 'ABSEN_MASUK_PERIODE_CACHE');
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
  getUsers,
  saveUser,
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
