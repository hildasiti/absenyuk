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

const ALLOWED_ORIGIN = '*'; // TODO: ganti ke domain GitHub Pages Anda setelah frontend live

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
      // 07:20 WIB - pengingat belum absen (pembatasan Senin-Jumat & cek hari libur
      // dilakukan DI DALAM cekDanKirimNotifikasiBelumAbsen(), bukan di cron - lihat
      // catatan lengkap soal ini di wrangler.toml).
      ctx.waitUntil(cekDanKirimNotifikasiBelumAbsen(env));
    } else if (event.cron === '20 5 * * *' || event.cron === '0 10 * * *') {
      // 12:20 WIB & 17:00 WIB - auto set Tanpa Keterangan (Absen Masuk). Dipanggil
      // 2x sehari karena beda sekolah bisa beda jam cutoff-nya sendiri
      // (settings.jam_cutoff_alpa) - fungsinya sendiri yang menentukan sekolah mana
      // yang sudah waktunya diproses di jam berapa (lihat catatan di wrangler.toml).
      ctx.waitUntil(autoSetTanpaKeterangan(env));
    } else if (event.cron === '0 14 * * *') {
      // 21:00 WIB - auto set "Tidak Absen" untuk Sholat Dzuhur & Ashar sekaligus
      // (jam ini dipilih supaya kedua sesi sudah pasti lewat, termasuk untuk
      // sekolah dgn jam masuk siang seperti MDT/DTA).
      ctx.waitUntil(autoSetTidakAbsenSholat(env));
    }
  }
};
