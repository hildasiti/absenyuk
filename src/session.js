/**
 * Session login disimpan di Workers KV dengan TTL 6 hari (518400 detik).
 * Durasi ini murni soal kenyamanan (guru tidak perlu login ulang tiap
 * beberapa jam) - TIDAK ADA hubungannya dengan FCM/push notification, yang
 * memakai token terpisah (fcm_token di tabel users, dengan otentikasi Google
 * Service Account sendiri) dan tetap berfungsi normal walau sesi ini sudah
 * kedaluwarsa.
 */

const SESSION_TTL_SECONDS = 518400;

export async function createSession(env, userObj) {
  const token = crypto.randomUUID();
  await env.SESSIONS.put(token, JSON.stringify(userObj), { expirationTtl: SESSION_TTL_SECONDS });
  return token;
}

export async function getSession(env, token) {
  if (!token) return null;
  const raw = await env.SESSIONS.get(token);
  return raw ? JSON.parse(raw) : null;
}

export async function destroySession(env, token) {
  if (!token) return;
  await env.SESSIONS.delete(token);
}
