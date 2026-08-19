/**
 * ====================================================================
 * ABSENYUK! WORKER — pengganti Code.gs (Apps Script)
 * ====================================================================
 * Endpoint yang sudah tersedia di file ini: login, session check, logout.
 * Endpoint lain (absen masuk, kegiatan, rekap, dst) ditambahkan satu
 * per satu mengikuti pola yang sama seperti handleLogin di bawah.
 * ====================================================================
 */

import { sbGetOne, sbSelect, sbInsert } from './supabase.js';
import { createSession, getSession, destroySession } from './session.js';
import { verifyAndMigratePassword } from './auth.js';
import { getSettingsMap } from './settings.js';
import { checkApakahHariLibur, hitungRadiusGPS } from './libur.js';
import { nowJakarta } from './date.js';

// Ganti dengan domain Cloudflare Pages Anda setelah deploy frontend,
// supaya browser lain tidak bisa panggil API ini seenaknya (CORS).
const ALLOWED_ORIGIN = '*'; // TODO: ganti ke 'https://absenyuk.pages.dev' saat production

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

async function handleLogin(request, env) {
  const { nuptk, password } = await request.json();

  if (!nuptk || !password) {
    return json({ success: false, message: 'NUPTK dan password wajib diisi.' }, 400);
  }

  const inputNuptk = String(nuptk).trim();
  const inputPass = String(password).trim();

  const userRow = await sbGetOne(env, 'users', 'nuptk', inputNuptk);
  if (!userRow) {
    return json({ success: false, message: 'NUPTK/User atau Password tidak cocok.' });
  }

  const passwordOk = await verifyAndMigratePassword(env, userRow, inputPass);
  if (!passwordOk) {
    return json({ success: false, message: 'NUPTK/User atau Password tidak cocok.' });
  }

  if (String(userRow.status).trim() !== 'Aktif') {
    return json({ success: false, message: 'Akun Anda dinonaktifkan oleh Admin.' });
  }

  const userObj = {
    id: userRow.legacy_id,
    nuptk: userRow.nuptk,
    nama: userRow.nama,
    role: String(userRow.role).trim().toUpperCase().replace(/\s+/g, '_'),
    kategori: userRow.kategori || 'Mengajar'
  };

  const token = await createSession(env, userObj);
  return json({ success: true, token, user: userObj });
}

async function handleCheckSession(request, env) {
  const { token } = await request.json();
  const session = await getSession(env, token);
  return json(session); // null kalau tidak valid/expired, sama seperti checkSession() lama
}

async function handleLogout(request, env) {
  const { token } = await request.json();
  await destroySession(env, token);
  return json({ success: true });
}

/** Ambil session dari header Authorization: Bearer <token>. Return null kalau tidak valid. */
async function requireSession(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  return getSession(env, token);
}

function generateShortID(prefix) {
  const karakter = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let hasil = '';
  for (let i = 0; i < 6; i++) hasil += karakter.charAt(Math.floor(Math.random() * karakter.length));
  return prefix + '_' + hasil;
}

async function handleSaveAbsenMasuk(request, env) {
  const user = await requireSession(request, env);
  if (!user) return json({ success: false, message: 'Sesi habis, silakan login ulang.' });

  const { status, keterangan, lat, lon } = await request.json();

  const { dateStr, timeStr: jamLaporStr, dayOfWeek } = nowJakarta();

  // 1. Cek hari libur
  let statusLiburSistem = '';
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    statusLiburSistem = 'Libur Akhir Pekan';
  } else {
    const namaLiburNasional = await checkApakahHariLibur(env, dateStr);
    if (namaLiburNasional) statusLiburSistem = 'Libur Nasional: ' + namaLiburNasional;
  }
  if (statusLiburSistem !== '') {
    return json({ success: false, message: 'Presensi Ditolak! Hari ini sistem dinonaktifkan karena agenda [' + statusLiburSistem + '].' });
  }

  // 2. Cek duplikat: sudah absen hari ini?
  const existing = await sbSelect(env, 'absen_masuk', `nuptk=eq.${encodeURIComponent(user.nuptk)}&tanggal=eq.${dateStr}&limit=1`);
  if (existing.length > 0) {
    return json({ success: false, message: 'Anda sudah melakukan presensi masuk hari ini pada pukul ' + existing[0].jam + ' WIB.' });
  }

  // 3. Validasi GPS
  if (!lat || !lon || lat === '-' || lon === '-') {
    return json({ success: false, message: 'Gagal memverifikasi koordinat GPS. Pastikan izin lokasi aktif.' });
  }

  const settings = await getSettingsMap(env);
  let finalStatus = status;

  const mapsLink = `https://www.google.com/maps?q=${lat},${lon}`;
  const jarakMeter = hitungRadiusGPS(parseFloat(lat), parseFloat(lon), parseFloat(settings.lat_sekolah), parseFloat(settings.long_sekolah));

  if (status === 'Hadir') {
    if (jarakMeter > parseInt(settings.radius || 50, 10)) {
      return json({ success: false, message: `Posisi Anda berada di luar radius sekolah (${jarakMeter} meter). Silakan mendekat ke area sekolah.` });
    }
    const [jamMasukH, jamMasukM] = settings.jam_masuk.split(':').map(Number);
    const [jamLaporH, jamLaporM] = jamLaporStr.split(':').map(Number);
    const menitMasuk = jamMasukH * 60 + jamMasukM;
    const menitBatas = menitMasuk + parseInt(settings.toleransi || 15, 10);
    const menitLapor = jamLaporH * 60 + jamLaporM;
    finalStatus = menitLapor > menitBatas ? 'Terlambat' : 'Hadir';
  }

  // 4. Simpan. Kalau ada race condition (2 request nyaris bersamaan lolos cek
  // duplikat di atas), unique constraint (nuptk, tanggal) di Postgres akan
  // menolak baris kedua - ditangkap di catch di bawah sebagai pesan yang sama.
  try {
    await sbInsert(env, 'absen_masuk', {
      id: generateShortID('AB'),
      tanggal: dateStr,
      nuptk: user.nuptk,
      nama: user.nama,
      jam: jamLaporStr,
      latitude: String(lat),
      longitude: String(lon),
      jarak: jarakMeter + ' m',
      status: finalStatus,
      keterangan: keterangan || '-',
      maps_link: mapsLink
    });
  } catch (err) {
    if (String(err.message).includes('duplicate key')) {
      return json({ success: false, message: 'Anda sudah melakukan presensi masuk hari ini.' });
    }
    throw err;
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

  return json({ success: true, message: pesanSukses });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    try {
      if (request.method === 'POST' && url.pathname === '/api/login') {
        return await handleLogin(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/session') {
        return await handleCheckSession(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/logout') {
        return await handleLogout(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/absen-masuk') {
        return await handleSaveAbsenMasuk(request, env);
      }

      return json({ success: false, message: 'Endpoint tidak ditemukan: ' + url.pathname }, 404);
    } catch (err) {
      return json({ success: false, message: 'CRITICAL BACKEND ERROR: ' + err.message }, 500);
    }
  }
};
