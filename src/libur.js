import { sbSelect } from './supabase.js';

/**
 * Padanan hitungRadiusGPS() - rumus Haversine, hasil dalam meter.
 * Logic-nya persis sama, cuma dipindah ke JS modul biasa.
 */
export function hitungRadiusGPS(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

/**
 * Cek apakah sebuah tanggal termasuk hari libur. Cache 5 menit di KV
 * karena dipanggil di tiap absen masuk.
 */
export async function checkApakahHariLibur(env, targetDateStr) {
  const cacheKey = 'LIBUR_LIST_CACHE';
  let liburList;
  const cached = await env.SESSIONS.get(cacheKey);
  if (cached) {
    liburList = JSON.parse(cached);
  } else {
    liburList = await sbSelect(env, 'libur_nasional');
    await env.SESSIONS.put(cacheKey, JSON.stringify(liburList), { expirationTtl: 300 });
  }

  const targetTime = new Date(targetDateStr).getTime();
  for (const l of liburList) {
    const startTime = new Date(l.tgl_mulai).getTime();
    const endTime = new Date(l.tgl_selesai).getTime();
    if (targetTime >= startTime && targetTime <= endTime) return l.keterangan;
  }
  return null;
}
