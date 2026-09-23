import { getGoogleAccessToken } from './googleAuth.js';

/**
 * ====================================================================
 * GOOGLE DRIVE UPLOAD (kop surat, dsb)
 * ====================================================================
 * Upload file (base64) ke Google Drive lewat service account YANG SAMA
 * dipakai untuk FCM (env.FCM_CLIENT_EMAIL / env.FCM_PRIVATE_KEY) - tidak
 * perlu bikin service account baru, tinggal reuse yang sudah ada.
 *
 * SETUP SEKALI SAJA (manual, di luar kode):
 *   1. Buat 1 folder khusus di Google Drive Abang (mis. "AbsenYuk - Kop Surat").
 *   2. Share folder itu ke alamat email service account (nilai env.FCM_CLIENT_EMAIL,
 *      formatnya semacam ...@....iam.gserviceaccount.com) dengan peran EDITOR.
 *   3. Buka folder itu di browser, salin ID-nya dari URL
 *      (drive.google.com/drive/folders/<ID_INI>), simpan sebagai Worker
 *      Secret baru bernama DRIVE_KOP_FOLDER_ID.
 * Scope yang dipakai sengaja 'drive.file' (BUKAN 'drive' penuh) - cukup
 * untuk membuat file baru di folder yang sudah di-share itu, TANPA service
 * account ini bisa mengakses seluruh isi Drive pribadi Abang yang lain.
 * ====================================================================
 */
export async function uploadFileKeDrive(env, base64Data, mimeType, namaFile) {
  const accessToken = await getGoogleAccessToken(
    env, env.FCM_CLIENT_EMAIL, env.FCM_PRIVATE_KEY,
    'https://www.googleapis.com/auth/drive.file',
    'DRIVE_ACCESS_TOKEN' // cache key TERPISAH dari FCM_ACCESS_TOKEN - scope beda, token tidak boleh ketuker
  );

  const metadata = { name: namaFile, parents: [env.DRIVE_KOP_FOLDER_ID] };
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
  // terlepas dari apakah browser mereka sedang login akun Google yang sama
  // dengan Abang atau tidak (kebanyakan guru pasti tidak).
  const permRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' })
  });
  if (!permRes.ok) throw new Error(`Gagal set izin publik file Drive (${permRes.status}): ${await permRes.text()}`);

  return { fileId, url: `https://drive.google.com/uc?export=view&id=${fileId}` };
}
