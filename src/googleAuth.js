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
