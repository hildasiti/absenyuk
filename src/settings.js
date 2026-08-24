import { sbSelect } from './supabase.js';

/**
 * Baca tabel settings (key-value, per sekolah) dari Supabase. Jarang
 * berubah tapi dibaca di hampir setiap absen masuk, jadi di-cache
 * 5 menit di KV. Cache key disertai sekolahId supaya tidak ketuker
 * antar sekolah.
 */
export async function getSettingsMap(env, sekolahId) {
  const cacheKey = `SETTINGS_CACHE_${sekolahId}`;
  const cached = await env.SESSIONS.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const rows = await sbSelect(env, 'settings', `sekolah_id=eq.${sekolahId}`);
  const map = {};
  rows.forEach((r) => { map[r.key] = r.value; });

  await env.SESSIONS.put(cacheKey, JSON.stringify(map), { expirationTtl: 300 });
  return map;
}
