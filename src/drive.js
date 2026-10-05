import { getGoogleAccessTokenDariRefreshToken } from './googleAuth.js';

/**
 * ====================================================================
 * GOOGLE DRIVE UPLOAD (kop surat sekolah)
 * ====================================================================
 * Upload berjalan ATAS NAMA akun Google pribadi pemilik aplikasi (lewat
 * refresh_token, lihat getGoogleAccessTokenDariRefreshToken di
 * googleAuth.js) - BUKAN service account, karena service account di project
 * non-Workspace punya kuota Drive NOL (upload selalu gagal storageQuota-
 * Exceeded walau folder tujuannya sudah di-share Editor sekalipun).
 *
 * Admin sekolah TIDAK perlu login/pilih akun Google apa pun - cukup pilih
 * file, backend yang mengurus semuanya di belakang layar pakai kredensial
 * pemilik aplikasi. Folder tujuan ("AbsenYuk - Kop Surat") dicari/dibuat
 * OTOMATIS di Drive pemilik - tidak perlu setup share folder manual.
 *
 * SETUP SEKALI SAJA - lihat README bagian "Setup Kop Surat" untuk cara
 * mendapatkan DRIVE_OWNER_REFRESH_TOKEN, DRIVE_OWNER_CLIENT_ID, dan
 * DRIVE_OWNER_CLIENT_SECRET (Worker Secrets).
 * ====================================================================
 */

/**
 * ====================================================================
 * JALUR UTAMA: GOOGLE APPS SCRIPT "GERBANG DRIVE" (tanpa refresh token)
 * ====================================================================
 * Refresh token OAuth ikut kedaluwarsa tiap 7 hari kalau OAuth consent screen
 * berstatus "Testing" (dan baru bisa dihindari dengan "Publish app", yang
 * menuntut verifikasi Google kalau ada logo/domain). Jalur ini menghindarinya
 * total: sebuah Apps Script milik akun Drive pemilik (di-deploy sebagai web
 * app "Execute as: Me", "Who has access: Anyone") menerima file dari Worker
 * lalu menyimpannya ke Drive pemilik. Script berjalan atas nama pemilik
 * sendiri, otorisasinya tidak berumur 7 hari seperti token OAuth Testing.
 *
 * Aktif otomatis kalau env.DRIVE_SCRIPT_URL & env.DRIVE_SCRIPT_KEY terisi
 * (Worker Secrets). Kalau tidak, kode di bawah tetap memakai jalur OAuth
 * refresh token seperti sebelumnya - jadi tidak ada yang rusak.
 * Source Apps Script-nya ada di file kop-surat-gateway.gs.
 */
function pakaiAppsScript(env) {
  return !!(env.DRIVE_SCRIPT_URL && env.DRIVE_SCRIPT_KEY);
}

/** True kalau salah satu jalur (Apps Script ATAU OAuth refresh token) sudah disetup. */
export function driveSudahDisetup(env) {
  return pakaiAppsScript(env) ||
    !!(env.DRIVE_OWNER_REFRESH_TOKEN && env.DRIVE_OWNER_CLIENT_ID && env.DRIVE_OWNER_CLIENT_SECRET);
}

async function panggilAppsScript(env, payload) {
  // text/plain = "simple request" - tidak butuh preflight. Apps Script membalas
  // 302 ke script.googleusercontent.com; fetch Workers mengikuti redirect itu
  // otomatis dan hasil akhirnya JSON.
  const res = await fetch(env.DRIVE_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ key: env.DRIVE_SCRIPT_KEY, ...payload }),
    redirect: 'follow'
  });
  const teks = await res.text();
  let json;
  try { json = JSON.parse(teks); } catch (e) {
    // Biasanya HTML halaman login Google: web app belum di-deploy "Anyone" atau URL salah.
    throw new Error(`Apps Script tidak membalas JSON (${res.status}). Periksa URL deploy & akses "Anyone". Cuplikan: ${teks.slice(0, 160).replace(/\s+/g, ' ')}`);
  }
  if (!json.ok) throw new Error('Apps Script menolak: ' + json.error);
  return json;
}

async function cariAtauBuatFolderKopSurat(accessToken) {
  const q = encodeURIComponent("name='AbsenYuk - Kop Surat' and mimeType='application/vnd.google-apps.folder' and trashed=false");
  const cariRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`, {
    headers: { Authorization: 'Bearer ' + accessToken }
  });
  if (!cariRes.ok) throw new Error(`Gagal mencari folder Drive (${cariRes.status}): ${await cariRes.text()}`);
  const cariJson = await cariRes.json();
  if (cariJson.files && cariJson.files.length) return cariJson.files[0].id;

  const buatRes = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'AbsenYuk - Kop Surat', mimeType: 'application/vnd.google-apps.folder' })
  });
  if (!buatRes.ok) throw new Error(`Gagal membuat folder Drive (${buatRes.status}): ${await buatRes.text()}`);
  const buatJson = await buatRes.json();
  return buatJson.id;
}

export async function uploadFileKeDrive(env, base64Data, mimeType, namaFile) {
  if (pakaiAppsScript(env)) {
    const { fileId } = await panggilAppsScript(env, { action: 'upload', base64: base64Data, mimeType, namaFile });
    if (!fileId) throw new Error('Apps Script tidak mengembalikan ID file.');
    // Format URL SAMA PERSIS dengan jalur OAuth di bawah - frontend, cetak PDF, dan
    // getGambarDataUri (Simpan Gambar PNG) tidak perlu tahu jalur mana yang dipakai.
    return { fileId, url: `https://drive.google.com/thumbnail?id=${fileId}&sz=w1000` };
  }

  const accessToken = await getGoogleAccessTokenDariRefreshToken(env);
  const folderId = await cariAtauBuatFolderKopSurat(accessToken);

  const metadata = { name: namaFile, parents: [folderId] };
  const boundary = 'absenyuk-' + crypto.randomUUID();
  const binaryData = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));

  // Multipart upload manual (Cloudflare Workers tidak punya library resmi
  // Google API Node.js) - 2 bagian: metadata JSON, lalu data biner gambar.
  const encoder = new TextEncoder();
  const bagianAwal = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
  );
  const bagianAkhir = encoder.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(bagianAwal.length + binaryData.length + bagianAkhir.length);
  body.set(bagianAwal, 0);
  body.set(binaryData, bagianAwal.length);
  body.set(bagianAkhir, bagianAwal.length + binaryData.length);

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
  if (!res.ok) throw new Error(`Upload ke Google Drive gagal (${res.status}): ${await res.text()}`);
  const { id: fileId } = await res.json();

  // Set izin publik "siapa saja yang punya link bisa lihat" - supaya kop
  // surat tetap tampil untuk SIAPA PUN yang buka aplikasi/cetak laporan,
  // terlepas dari akun Google apa pun yang sedang dipakai browser mereka.
  const permRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' })
  });
  if (!permRes.ok) throw new Error(`Gagal set izin publik file Drive (${permRes.status}): ${await permRes.text()}`);

  // "thumbnail" lebih reliable dipakai langsung sebagai <img src> daripada
  // "uc?export=view" (kadang diarahkan ke halaman konfirmasi, bukan bytes
  // gambarnya) - sudah terverifikasi bekerja di fitur ini sebelumnya.
  return { fileId, url: `https://drive.google.com/thumbnail?id=${fileId}&sz=w1000` };
}

/** Ambil ID file Drive dari URL gambar yang kita simpan (format .../thumbnail?id=FILE_ID&sz=...). */
export function ambilFileIdDariUrl(url) {
  const m = String(url || '').match(/[?&]id=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Hapus file gambar dari Drive pemilik aplikasi (berdasarkan URL yang tersimpan).
 * File 404 (sudah terhapus manual) dianggap sukses. Return { ok, pesan }.
 * Dipakai supaya gambar - terutama tanda tangan digital yang berlink publik -
 * tidak menumpuk/tertinggal di Drive setelah dihapus atau diganti di Pengaturan.
 */
export async function hapusFileDriveDariUrl(env, url) {
  const fileId = ambilFileIdDariUrl(url);
  if (!fileId) return { ok: false, pesan: 'ID file Drive tidak ditemukan di URL.' };
  if (pakaiAppsScript(env)) {
    try {
      await panggilAppsScript(env, { action: 'hapus', fileId });
      return { ok: true };
    } catch (err) {
      return { ok: false, pesan: err.message };
    }
  }
  try {
    const accessToken = await getGoogleAccessTokenDariRefreshToken(env);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + accessToken }
    });
    if (res.ok || res.status === 404) return { ok: true };
    return { ok: false, pesan: `Drive menolak penghapusan (${res.status}): ${await res.text()}` };
  } catch (err) {
    return { ok: false, pesan: err.message };
  }
}
