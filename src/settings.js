import { sbSelect } from './supabase.js';

/**
 * Baca tabel settings (key-value) dari Supabase. Jarang berubah tapi
 * dibaca di hampir setiap absen masuk, jadi di-cache 5 menit di KV.
 */
export async function getSettingsMap(env) {
  const cached = await env.SESSIONS.get('SETTINGS_CACHE');
  if (cached) return JSON.parse(cached);

  const rows = await sbSelect(env, 'settings');
  const map = {};
  rows.forEach((r) => { map[r.key] = r.value; });

  await env.SESSIONS.put('SETTINGS_CACHE', JSON.stringify(map), { expirationTtl: 300 });
  return map;
}
