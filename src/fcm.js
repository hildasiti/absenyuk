import { getGoogleAccessToken } from './googleAuth.js';

/**
 * Padanan kirimNotifikasiKeSatuHP() yang lama (implementasinya tidak ada
 * di file yang diupload, jadi ditulis ulang pakai FCM HTTP v1 API - cara
 * resmi Google saat ini, menggantikan "legacy server key" API yang sudah
 * deprecated).
 *
 * Butuh 3 secret Worker baru: FCM_PROJECT_ID, FCM_CLIENT_EMAIL,
 * FCM_PRIVATE_KEY - kemungkinan besar NILAINYA SAMA dengan
 * FIRESTORE_PROJECT_ID / FIRESTORE_CLIENT_EMAIL / FIRESTORE_PRIVATE_KEY
 * yang sudah ada di Script Properties Apps Script (satu service account
 * Firebase biasanya punya izin Firestore + Cloud Messaging sekaligus).
 */
export async function kirimNotifikasiKeSatuHP(env, fcmToken, judul, pesan) {
  if (!fcmToken) return { success: false, message: 'Token FCM kosong.' };

  const accessToken = await getGoogleAccessToken(
    env, env.FCM_CLIENT_EMAIL, env.FCM_PRIVATE_KEY,
    'https://www.googleapis.com/auth/firebase.messaging',
    'FCM_ACCESS_TOKEN'
  );

  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: { token: fcmToken, notification: { title: judul, body: pesan } }
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    return { success: false, message: 'FCM gagal (' + res.status + '): ' + errText };
  }
  return { success: true };
}
