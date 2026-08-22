/** Padanan pola "cache.get / kalau kosong query lalu cache.put" yang berulang di code.gs. */
export async function cached(env, key, ttlSeconds, fetchFn) {
  const hit = await env.SESSIONS.get(key);
  if (hit) return JSON.parse(hit);
  const fresh = await fetchFn();
  await env.SESSIONS.put(key, JSON.stringify(fresh), { expirationTtl: ttlSeconds });
  return fresh;
}

export async function invalidate(env, key) {
  await env.SESSIONS.delete(key);
}
