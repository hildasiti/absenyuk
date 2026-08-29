import bcrypt from 'bcryptjs';
import { sbUpdate } from './supabase.js';

/**
 * Beberapa akun hasil migrasi data awal masih menyimpan password
 * PLAINTEXT (belum sempat di-hash). Daripada memaksa semua guru reset
 * password saat migrasi, dipakai strategi "migrate on login":
 *
 * 1. Kalau nilai di kolom password sudah berbentuk hash bcrypt
 *    (diawali "$2a$"/"$2b$"/dst), verifikasi pakai bcrypt seperti biasa.
 * 2. Kalau belum (masih plaintext, sisa data lama), bandingkan langsung
 *    sebagai string. Kalau cocok: LOGIN BERHASIL, dan sebagai efek
 *    samping password langsung di-hash & disimpan ulang ke Supabase —
 *    jadi setelah login pertama pasca-migrasi, akun itu otomatis sudah
 *    aman (hashed), tanpa guru perlu melakukan apa-apa.
 */
export async function verifyAndMigratePassword(env, userRow, inputPassword) {
  const stored = String(userRow.password || '');
  const isBcryptHash = /^\$2[aby]\$/.test(stored);

  if (isBcryptHash) {
    return bcrypt.compare(inputPassword, stored);
  }

  // Legacy plaintext
  const match = stored.trim() === inputPassword.trim();
  if (match) {
    const newHash = await bcrypt.hash(inputPassword, 10);
    // Tidak perlu di-await blocking respons login — tapi di Workers,
    // request bisa berhenti begitu response dikirim, jadi tetap di-await
    // supaya rehash-nya benar-benar tersimpan.
    await sbUpdate(env, 'users', 'nuptk', userRow.nuptk, { password: newHash });
  }
  return match;
}

/** Hash password baru pakai bcrypt - dipakai fitur ganti password mandiri (changePassword di handlers.js). */
export async function hashPassword(plainPassword) {
  return bcrypt.hash(plainPassword, 10);
}
