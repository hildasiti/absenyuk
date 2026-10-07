/**
 * ====================================================================
 * SUPABASE HELPER
 * ====================================================================
 * Fetch langsung ke PostgREST (REST API bawaan Supabase), pakai
 * service_role key supaya bypass RLS (Worker = backend trusted).
 * Ini satu-satunya cara Worker bicara ke database.
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

/**
 * Insert BANYAK baris sekaligus dalam 1 request HTTP (PostgREST mendukung body
 * berupa array). Dipakai khusus di fungsi-fungsi otomasi (auto alpa, auto tidak
 * absen) yang bisa memproses puluhan/ratusan baris sekaligus - insert satu-satu
 * dalam loop gampang menabrak limit "Too many subrequests by single Worker
 * invocation" di Cloudflare Workers (tiap fetch() ke Supabase dihitung 1 subrequest).
 * Return array baris yang berhasil dibuat.
 */
export async function sbInsertMany(env, table, dataArray) {
  if (!dataArray.length) return [];
  const url = `${env.SUPABASE_URL}/rest/v1/${table}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: baseHeaders(env, { Prefer: 'return=representation' }),
    body: JSON.stringify(dataArray)
  });
  if (!res.ok) throw new Error(`Supabase BULK INSERT ${table} gagal (${res.status}): ${await res.text()}`);
  return res.json();
}

/**
 * Upsert (insert-atau-update) BANYAK baris sekaligus dalam 1 request HTTP,
 * pakai kemampuan native PostgREST (header Prefer: resolution=merge-duplicates
 * + parameter on_conflict). Kolom di onConflict WAJIB berupa unique/primary
 * key gabungan di tabelnya (mis. 'sekolah_id,key' di tabel settings) supaya
 * Postgres tahu baris mana yang harus di-update vs di-insert baru.
 *
 * Dipakai untuk kasus seperti saveSettingsData(): dulu tiap key pengaturan
 * (bisa belasan sekaligus) diproses satu-satu lewat SELECT dulu (cek ada/
 * tidak) lalu UPDATE/INSERT - total bisa puluhan round-trip berurutan ke
 * Supabase, itu yang bikin "Simpan Pengaturan" terasa lama. Dengan upsert
 * bulk begini, semuanya jadi SATU request saja.
 */
export async function sbUpsertMany(env, table, dataArray, onConflictColumns) {
  if (!dataArray.length) return [];
  const url = `${env.SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflictColumns}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: baseHeaders(env, { Prefer: 'resolution=merge-duplicates,return=representation' }),
    body: JSON.stringify(dataArray)
  });
  if (!res.ok) throw new Error(`Supabase UPSERT ${table} gagal (${res.status}): ${await res.text()}`);
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

/** Update baris berdasarkan LEBIH DARI SATU filter kolom sekaligus (untuk primary key gabungan). */
export async function sbUpdateWhere(env, table, filters, data) {
  // PENTING: filter dengan nilai null HARUS pakai operator PostgREST 'is.null',
  // BUKAN 'eq.' - encodeURIComponent(null) menghasilkan teks "null" (string),
  // dan 'kolom=eq.null' di PostgREST artinya "cari baris yang isinya PERSIS
  // teks 'null'", BUKAN "cari baris yang kosong (NULL)". Filter seperti itu
  // tidak akan pernah cocok dengan baris manapun (kolom NULL sungguhan tidak
  // pernah "eq" apa pun, termasuk teks "null") - update jadi selalu gagal
  // menemukan barisnya. Ini persis penyebab bug "Anda sudah melakukan
  // Presensi Pulang hari ini" yang muncul di percobaan PERTAMA guru (belum
  // pernah pulang sama sekali) - saveAbsenPulang() memfilter jam_pulang: null
  // untuk memastikan cuma meng-update baris yang belum diisi, tapi filter itu
  // tidak pernah match sama sekali sebelum perbaikan ini.
  const filterQuery = Object.entries(filters)
    .map(([col, val]) => val === null ? `${col}=is.null` : `${col}=eq.${encodeURIComponent(val)}`)
    .join('&');
  const url = `${env.SUPABASE_URL}/rest/v1/${table}?${filterQuery}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: baseHeaders(env, { Prefer: 'return=representation' }),
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error(`Supabase UPDATE ${table} gagal (${res.status}): ${await res.text()}`);
  const rows = await res.json();
  return rows[0];
}

/**
 * Hapus baris berdasarkan LEBIH DARI SATU filter kolom (semua harus cocok), mis. hanya
 * baris "Tanpa Keterangan" otomatis milik satu NUPTK. Wajib ada minimal 1 filter supaya
 * tidak pernah bisa menghapus seluruh tabel tanpa sengaja. Return jumlah baris terhapus.
 */
export async function sbDeleteWhere(env, table, filters) {
  const filterQuery = Object.entries(filters || {})
    .map(([col, val]) => val === null ? `${col}=is.null` : `${col}=eq.${encodeURIComponent(val)}`)
    .join('&');
  if (!filterQuery) throw new Error('sbDeleteWhere butuh minimal satu filter.');
  const url = `${env.SUPABASE_URL}/rest/v1/${table}?${filterQuery}`;
  const res = await fetch(url, { method: 'DELETE', headers: baseHeaders(env, { Prefer: 'return=representation' }) });
  if (!res.ok) throw new Error(`Supabase DELETE ${table} gagal (${res.status}): ${await res.text()}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows.length : 0;
}

/** Hapus baris berdasarkan filter kolom = value. */
export async function sbDelete(env, table, column, value) {
  const url = `${env.SUPABASE_URL}/rest/v1/${table}?${column}=eq.${encodeURIComponent(value)}`;
  const res = await fetch(url, { method: 'DELETE', headers: baseHeaders(env) });
  if (!res.ok) throw new Error(`Supabase DELETE ${table} gagal (${res.status}): ${await res.text()}`);
  return true;
}
