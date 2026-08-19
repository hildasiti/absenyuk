/**
 * ====================================================================
 * ABSENYUK! WORKER — pengganti Code.gs (Apps Script)
 * ====================================================================
 * Endpoint yang sudah tersedia di file ini: login, session check, logout.
 * Endpoint lain (absen masuk, kegiatan, rekap, dst) ditambahkan satu
 * per satu mengikuti pola yang sama seperti handleLogin di bawah.
 * ====================================================================
 */

import { sbGetOne } from './supabase.js';
import { createSession, getSession, destroySession } from './session.js';
import { verifyAndMigratePassword } from './auth.js';

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

      return json({ success: false, message: 'Endpoint tidak ditemukan: ' + url.pathname }, 404);
    } catch (err) {
      return json({ success: false, message: 'CRITICAL BACKEND ERROR: ' + err.message }, 500);
    }
  }
};
