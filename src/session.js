/**
 * Session login disimpan di Workers KV dengan TTL 6 jam (21600 detik).
 */

const SESSION_TTL_SECONDS = 21600;

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
