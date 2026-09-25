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
