/**
 * ====================================================================
 * ABSENYUK! WORKER
 * ====================================================================
 * Backend tunggal AbsenYuk!: satu endpoint menerima { action, args },
 * mencari fungsinya di handlers.js, menjalankan, lalu mengembalikan
 *   Sukses : { success: true, data: <hasil fungsi> }
 *   Gagal  : { success: false, error: "pesan error" }
 * Frontend (index.html, di-hosting GitHub Pages) memanggil endpoint ini
 * lewat pola google.script.run(...).namaFungsi(...) - nama itu cuma
 * konvensi penamaan JS di frontend, isinya murni fetch() ke sini.
 *
 * "scheduled" di bawah dipicu otomatis oleh Cron Triggers Cloudflare
 * sesuai jadwal di wrangler.toml, terpisah dari request dari frontend.
 * ====================================================================
 */

import { handlers, autoSetTanpaKeterangan, cekDanKirimNotifikasiBelumAbsen, autoSetTidakAbsenSholat } from './handlers.js';
import { getSession } from './session.js';

const ALLOWED_ORIGIN = '*'; // TODO: ganti ke domain GitHub Pages Anda setelah frontend live

// Aksi yang BOLEH dipanggil tanpa sesi valid (belum/baru mau login).
// Semua aksi LAIN di luar daftar ini WAJIB punya token sesi yang masih
// hidup di args[0] - kalau tidak, request ditolak SEBELUM sampai ke
// handler manapun, dengan sinyal yang selalu sama: error 'SESSION_EXPIRED'.
// Ini titik tunggal supaya frontend tidak perlu menebak-nebak bentuk
// respons "belum login" dari puluhan fungsi berbeda di handlers.js.
const AKSI_TANPA_SESI = ['loginUser', 'checkSession'];

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

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return json({ success: true, data: 'AbsenYuk Worker aktif.' });
    }

    if (request.method === 'POST') {
      try {
        const body = await request.json();
        const fnName = body.action || body.fn;
        const args = Array.isArray(body.args) ? body.args : [];

        const handler = handlers[fnName];
        if (!handler) {
          return json({ success: false, error: 'Fungsi tidak dikenal: ' + fnName }, 404);
        }

        // --- Penjagaan sesi terpusat ---
        if (!AKSI_TANPA_SESI.includes(fnName)) {
          const token = args[0];
          const session = await getSession(env, token);
          if (!session) {
            return json({ success: false, error: 'SESSION_EXPIRED' }, 401);
          }
        }

        const result = await handler(args, env);
        return json({ success: true, data: result });
      } catch (err) {
        return json({ success: false, error: 'CRITICAL BACKEND ERROR: ' + err.message }, 500);
      }
    }

    return json({ success: false, error: 'Endpoint tidak ditemukan: ' + url.pathname }, 404);
  },

  // Dipanggil otomatis oleh Cloudflare sesuai jadwal di wrangler.toml.
  // event.cron berisi expression cron yang cocok, dipakai untuk membedakan
  // beberapa jadwal berbeda yang jalan di Worker yang sama.
  async scheduled(event, env, ctx) {
    if (event.cron === '20 0 * * *') {
      ctx.waitUntil(cekDanKirimNotifikasiBelumAbsen(env));
    } else if (event.cron === '20 5 * * *' || event.cron === '0 10 * * *') {
      ctx.waitUntil(autoSetTanpaKeterangan(env));
    } else if (event.cron === '0 14 * * *') {
      ctx.waitUntil(autoSetTidakAbsenSholat(env));
    }
  }
};
