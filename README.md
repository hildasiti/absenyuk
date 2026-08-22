# AbsenYuk! — Backend (Cloudflare Worker)

Backend AbsenYuk! sekarang berjalan sepenuhnya di atas 3 layanan:
- **GitHub** — penyimpanan kode & pemicu deploy otomatis (push = deploy)
- **Cloudflare Workers** — backend/API (folder ini)
- **Supabase** — database (Postgres)

Frontend (`index.html`) di-hosting terpisah di **GitHub Pages**.

Tidak ada lagi ketergantungan ke Google Apps Script atau Firestore —
keduanya sudah sepenuhnya digantikan.

## Struktur project

```
absenyuk-worker/
├── wrangler.toml       # konfigurasi Worker: nama, KV binding, jadwal cron
├── package.json
└── src/
    ├── index.js         # entry point: routing request + jadwal cron
    ├── handlers.js       # semua logic bisnis (login, absen, dsb)
    ├── supabase.js       # helper baca/tulis ke Supabase (PostgREST)
    ├── session.js        # session login, disimpan di Workers KV
    ├── auth.js            # verifikasi & migrasi password
    ├── settings.js         # baca tabel settings (dengan cache)
    ├── libur.js             # cek hari libur + hitung jarak GPS
    ├── date.js               # jam/tanggal Asia/Jakarta yang akurat
    ├── cache.js               # helper cache generik di KV
    ├── googleAuth.js           # OAuth2 Service Account (dipakai FCM)
    └── fcm.js                   # kirim notifikasi push (Firebase Cloud Messaging)
```

## Cara deploy (lewat GitHub, tanpa command line)

1. Push/upload seluruh isi folder ini ke repo GitHub.
2. Di Cloudflare dashboard: **Workers & Pages > Create > Import a repository**, pilih repo tersebut. Cloudflare otomatis build & deploy setiap ada commit baru.
3. Buat KV namespace lewat dashboard (**Workers & Pages > KV > Create a namespace**, beri nama `SESSIONS`), lalu tempel Namespace ID-nya ke `wrangler.toml` (baris `id = "..."` di bagian `[[kv_namespaces]]`).
4. Isi secret di **Settings > Runtime > Variables and secrets** (bukan Build):
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — dari Supabase Project Settings > API
   - `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY` — dari service account Firebase (untuk fitur notifikasi push)
5. Cron Trigger (pengingat jam 07:20 & auto-alpa jam 12:00 WIB) otomatis aktif begitu `wrangler.toml` ter-deploy, tidak perlu setup manual tambahan.

## Cara kerja endpoint

Worker cuma punya **satu route** (`POST /`) yang menerima:
```json
{ "action": "namaFungsi", "args": [ /* argumen sesuai fungsi */ ] }
```
dan mengembalikan:
```json
{ "success": true, "data": /* hasil fungsi */ }
```
Semua nama fungsi yang bisa dipanggil ada di peta `handlers` di ujung `src/handlers.js`.

Frontend memanggil ini lewat shim `google.script.run` yang sudah tertanam di `index.html` — nama itu sekadar konvensi penamaan JavaScript di sana, isinya murni `fetch()` ke Worker ini.

## Menambah fungsi baru

1. Tulis fungsi baru di `handlers.js`, format `async function namaFungsi(args, env) { ... }` — `args[0]` biasanya token sesi (kecuali `loginUser`).
2. Daftarkan di objek `handlers` pada akhir file.
3. Selesai — tidak perlu sentuh `index.js` atau routing apa pun, dan tidak perlu ubah `index.html` selama nama fungsinya sama dengan yang dipanggil di frontend.
