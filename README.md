# AbsenYuk! Worker — Setup & Deploy

## 1. Install dependencies
```bash
cd absenyuk-worker
npm install
```

## 2. Login ke Cloudflare (sekali saja)
```bash
npx wrangler login
```
Ini akan buka browser untuk otorisasi akun Cloudflare Anda.

## 3. Buat KV namespace untuk session
```bash
npx wrangler kv namespace create SESSIONS
```
Perintah ini akan mengeluarkan output berisi `id = "xxxxxxxx"`. Salin id
itu, lalu tempel ke `wrangler.toml`, ganti bagian:
```toml
id = "GANTI_DENGAN_ID_NAMESPACE_KV"
```

## 4. Set secrets (SUPABASE_URL & SUPABASE_SERVICE_ROLE_KEY)
Ambil dari Supabase Dashboard > Project Settings > API.
```bash
npx wrangler secret put SUPABASE_URL
# tempel: https://xxxxx.supabase.co (TANPA trailing slash)

npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
# tempel: service_role key (BUKAN anon key -- ini yang bypass RLS)
```

## 5. Jalankan lokal untuk testing
```bash
npm run dev
```
Wrangler akan jalankan Worker di `http://localhost:8787`. Test login:
```bash
curl -X POST http://localhost:8787/api/login \
  -H "Content-Type: application/json" \
  -d '{"nuptk":"admin","password":"admins123"}'
```
Response yang diharapkan (login pertama = masih plaintext, otomatis
ter-hash setelah ini):
```json
{"success":true,"token":"...","user":{"id":"U01","nuptk":"admin","nama":"Administrator","role":"ADMIN","kategori":"Tidak Mengajar"}}
```

## 6. Deploy ke Cloudflare
```bash
npm run deploy
```
Setelah selesai, Wrangler menampilkan URL Worker Anda, contoh:
`https://absenyuk-worker.<subdomain-anda>.workers.dev`

Ini adalah URL pengganti `GAS_WEB_APP_URL` di frontend lama.

---

## Menambah endpoint baru

Setiap fungsi Apps Script (`saveAbsenMasuk`, `getDashboardData`, dst)
jadi 1 blok kode dengan pola yang sama seperti `handleLogin` di
`src/index.js`:

1. Buat fungsi `handleNamaFungsi(request, env)` — baca body via
   `await request.json()`, proses pakai helper dari `supabase.js`
   (`sbSelect`, `sbInsert`, `sbUpdate`, `sbDelete`), return `json({...})`.
2. Daftarkan route-nya di blok `if` dalam `fetch()`.
3. Kalau endpoint butuh login, tambahkan pengecekan session di awal
   fungsi:
   ```js
   const authHeader = request.headers.get('Authorization') || '';
   const token = authHeader.replace('Bearer ', '');
   const session = await getSession(env, token);
   if (!session) return json({ success: false, message: 'Sesi tidak valid.' }, 401);
   ```

Kirim daftar fungsi yang mau diprioritaskan dulu (misalnya
`saveAbsenMasuk` + `getDashboardData` dulu karena paling sering
dipakai), nanti saya portingkan satu-satu dengan pola yang sama.
oke oke 
