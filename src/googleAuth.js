/**
 * Padanan getFirestoreAccessToken() di FirestoreLayer.gs, tapi Workers
 * tidak punya Utilities.computeRsaSha256Signature seperti Apps Script -
 * jadi dipakai Web Crypto API (crypto.subtle) bawaan Workers.
 * Bisa dipakai untuk scope Google API apa saja, bukan cuma FCM.
 */

function base64UrlEncode(bytes) {
  let binary = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  arr.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function strToBase64Url(str) {
  return base64UrlEncode(new TextEncoder().encode(str));
}

async function importPrivateKey(pem) {
  const cleaned = pem
    .replace(/\\n/g, '\n')
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const binaryDer = Uint8Array.from(atob(cleaned), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8', binaryDer.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
}

/**
 * Ambil OAuth2 access token dari Service Account, di-cache di KV (55 menit,
 * sama seperti cache 3540 detik di FirestoreLayer.gs) supaya tidak generate
 * token baru di tiap request.
 */
export async function getGoogleAccessToken(env, clientEmail, privateKeyRaw, scope, cacheKey) {
  const cached = await env.SESSIONS.get(cacheKey);
  if (cached) return cached;

  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claimSet = {
    iss: clientEmail, scope, aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600, iat: now
  };

  const signatureInput = strToBase64Url(JSON.stringify(header)) + '.' + strToBase64Url(JSON.stringify(claimSet));
  const key = await importPrivateKey(privateKeyRaw);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signatureInput));
  const jwt = signatureInput + '.' + base64UrlEncode(signature);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });
  const result = await res.json();
  if (!result.access_token) throw new Error('Gagal dapat access token Google: ' + JSON.stringify(result));

  await env.SESSIONS.put(cacheKey, result.access_token, { expirationTtl: 3300 });
  return result.access_token;
}

/**
 * Ambil access token BARU dari refresh_token OAuth akun Google PRIBADI
 * (bukan service account) - dipakai khusus untuk upload logo kop surat ke
 * Google Drive supaya file benar-benar tersimpan di Drive pemilik aplikasi
 * dan pakai KUOTA SUNGGUHAN akun itu. Service account di project non-
 * Workspace punya kuota Drive NOL, jadi tidak bisa dipakai untuk ini sama
 * sekali (lihat drive.js) - refresh_token ini yang jadi gantinya.
 *
 * env.DRIVE_OWNER_REFRESH_TOKEN didapat SEKALI SAJA lewat proses login manual
 * (lihat README, pakai OAuth 2.0 Playground) - setelah itu backend bisa terus
 * minta access token baru tanpa admin sekolah mana pun perlu login apa pun
 * lagi. env.DRIVE_OWNER_CLIENT_ID/DRIVE_OWNER_CLIENT_SECRET adalah pasangan
 * OAuth Client ID (tipe Web application) yang dipakai untuk mendapat
 * refresh_token itu tadi.
 */
export async function getGoogleAccessTokenDariRefreshToken(env) {
  const cacheKey = 'DRIVE_OWNER_ACCESS_TOKEN';
  const cached = await env.SESSIONS.get(cacheKey);
  if (cached) return cached;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: env.DRIVE_OWNER_REFRESH_TOKEN,
      client_id: env.DRIVE_OWNER_CLIENT_ID,
      client_secret: env.DRIVE_OWNER_CLIENT_SECRET
    })
  });
  const result = await res.json();
  if (!result.access_token) throw new Error('Gagal refresh access token Google Drive: ' + JSON.stringify(result));

  // Simpan sedikit lebih pendek dari masa berlaku sesungguhnya (biasanya 3600
  // detik) - jaga-jaga supaya tidak terpakai saat sudah/nyaris kedaluwarsa.
  const ttl = Math.max(60, (result.expires_in || 3600) - 120);
  await env.SESSIONS.put(cacheKey, result.access_token, { expirationTtl: ttl });
  return result.access_token;
}
