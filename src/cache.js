/** Cache generik di Workers KV: ambil dari cache, kalau kosong jalankan fetchFn lalu simpan ke cache. */
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
