select 'users' as tabel, count(*) as jumlah from users
union all select 'settings', count(*) from settings
union all select 'absen_masuk', count(*) from absen_masuk
union all select 'jadwal_kegiatan', count(*) from jadwal_kegiatan
union all select 'absen_kegiatan_khusus', count(*) from absen_kegiatan_khusus
union all select 'libur_nasional', count(*) from libur_nasional
union all select 'rekap_jam_pelajaran', count(*) from rekap_jam_pelajaran
union all select 'afirmasi_guru', count(*) from afirmasi_guru
union all select 'kegiatan_umum', count(*) from kegiatan_umum
order by tabel;
