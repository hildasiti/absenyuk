/**
 * ====================================================================
 * SUPABASE HELPER — pengganti FirestoreLayer.gs
 * ====================================================================
 * Fetch langsung ke PostgREST (REST API bawaan Supabase), pakai
 * service_role key supaya bypass RLS (Worker = backend trusted).
 *
 * Padanan fungsi lama:
 *   firestoreGetDocument(col, id)     -> sbGetOne(env, table, filterCol, id)
 *   firestoreQuery(col, filters)      -> sbSelect(env, table, queryString)
 *   firestoreSetDocument(col, id, d)  -> sbUpdate(env, table, filterCol, id, data)
 *   firestoreAddDocument(col, data)   -> sbInsert(env, table, data)
 *   firestoreDeleteDocument(col, id)  -> sbDelete(env, table, filterCol, id)
 * ====================================================================
 */

function baseHeaders(env, extra) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
    ...extra
  };
}

/** Ambil satu baris berdasarkan filter kolom = value. Return null kalau tidak ada. */
export async function sbGetOne(env, table, column, value) {
  const url = `${env.SUPABASE_URL}/rest/v1/${table}?${column}=eq.${encodeURIComponent(value)}&limit=1`;
  const res = await fetch(url, { headers: baseHeaders(env) });
  if (!res.ok) throw new Error(`Supabase GET ${table} gagal (${res.status}): ${await res.text()}`);
  const rows = await res.json();
  return rows.length ? rows[0] : null;
}

/**
 * Select dengan query string PostgREST bebas, contoh:
 *   sbSelect(env, 'absen_masuk', 'nuptk=eq.alfin&tanggal=eq.2026-07-20')
 *   sbSelect(env, 'users', 'order=nama.asc')
 */
export async function sbSelect(env, table, queryString = '') {
  const url = `${env.SUPABASE_URL}/rest/v1/${table}${queryString ? '?' + queryString : ''}`;
  const res = await fetch(url, { headers: baseHeaders(env) });
  if (!res.ok) throw new Error(`Supabase SELECT ${table} gagal (${res.status}): ${await res.text()}`);
  return res.json();
}

/** Insert baris baru. Return baris yang baru dibuat. */
export async function sbInsert(env, table, data) {
  const url = `${env.SUPABASE_URL}/rest/v1/${table}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: baseHeaders(env, { Prefer: 'return=representation' }),
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error(`Supabase INSERT ${table} gagal (${res.status}): ${await res.text()}`);
  const rows = await res.json();
  return rows[0];
}

/** Update baris berdasarkan filter kolom = value. Return baris hasil update. */
export async function sbUpdate(env, table, column, value, data) {
  const url = `${env.SUPABASE_URL}/rest/v1/${table}?${column}=eq.${encodeURIComponent(value)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: baseHeaders(env, { Prefer: 'return=representation' }),
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error(`Supabase UPDATE ${table} gagal (${res.status}): ${await res.text()}`);
  const rows = await res.json();
  return rows[0];
}

/** Hapus baris berdasarkan filter kolom = value. */
export async function sbDelete(env, table, column, value) {
  const url = `${env.SUPABASE_URL}/rest/v1/${table}?${column}=eq.${encodeURIComponent(value)}`;
  const res = await fetch(url, { method: 'DELETE', headers: baseHeaders(env) });
  if (!res.ok) throw new Error(`Supabase DELETE ${table} gagal (${res.status}): ${await res.text()}`);
  return true;
}
