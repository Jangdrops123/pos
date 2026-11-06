// Fasilitas sistem untuk Pengaturan ▸ Keamanan & Sistem:
// info database, backup manual/terjadwal, pemulihan, dan pemeriksaan pembaruan.
//
// Backup memakai `pg_dump` format custom (.dump) sehingga menghasilkan
// cadangan konsisten tanpa mengunci tulis (aman dipakai saat aplikasi aktif).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { all, DATABASE_URL, get, ROOT_DIR, run } from '../db.pg.ts';
import { tolak } from './http.ts';

const execFileAsync = promisify(execFile);

/** Folder cadangan — dibuat saat dibutuhkan, tidak ikut disalin sebagai aset. */
export const LOKASI_BACKUP = path.join(ROOT_DIR, 'data', 'backups');
/** Ekstensi berkas cadangan PostgreSQL (format custom pg_dump, ringkas). */
export const EKSTENSI_CADANGAN = '.dump';

/**
 * Cari biner perkakas PostgreSQL (pg_dump/pg_restore/psql).
 * Urutan: env PG_BIN_DIR → PATH → lokasi baku instalasi Windows.
 */
function cariBiner(nama: string): string {
  const dariEnv = process.env.PG_BIN_DIR?.trim();
  if (dariEnv) {
    const p = path.join(dariEnv, process.platform === 'win32' ? `${nama}.exe` : nama);
    if (fs.existsSync(p)) return p;
  }
  const bakuWin = String.raw`C:\Program Files\PostgreSQL\18\bin`;
  const calonWin = path.join(bakuWin, `${nama}.exe`);
  if (process.platform === 'win32' && fs.existsSync(calonWin)) return calonWin;
  return nama; // andalkan PATH
}

function pastikanDatabaseUrl(): string {
  if (!DATABASE_URL) throw tolak(500, 'DATABASE_URL belum disetel — cadangan PostgreSQL tidak dapat dibuat.');
  return DATABASE_URL;
}

/** Versi aplikasi (diambil dari package.json — satu sumber kebenaran). */
export function versiAplikasi(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export interface InfoSistem {
  versi: string;
  namaDatabase: string;
  ukuranDb: number;
  waktuDatabase: string;
  migrasi: number;
  ringkasan: { nama: string; jumlah: number }[];
}

function ukuranBerkas(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/** Informasi database aktif + ringkasan jumlah data penting. */
export async  function infoSistem(): Promise<InfoSistem> {
  const hitung = async (sql: string): Promise<number> => {
    try {
      return Number((await get<{ n: number }>(sql))?.n ?? 0);
    } catch {
      return 0;
    }
  };
  // PostgreSQL tidak memakai tabel schema_migrations SQLite — jumlah berkas
  // migrasi PG (pg-migrations/*.sql) dipakai sebagai angka pembanding.
  let migrasi = 0;
  try {
    migrasi = fs.readdirSync(path.join(ROOT_DIR, 'pg-migrations')).filter((f) => f.endsWith('.sql')).length;
  } catch {
    migrasi = 0;
  }
  // Ukuran database aktif langsung dari PostgreSQL.
  let namaDb = '';
  let ukuranDb = 0;
  try {
    const info = await get<{ nama: string; ukuran: number }>(`SELECT current_database() AS nama, pg_database_size(current_database()) AS ukuran`);
    namaDb = info?.nama ?? '';
    ukuranDb = Number(info?.ukuran ?? 0);
  } catch {
    /* database tak terjangkau — laporkan nol */
  }
  return {
    versi: versiAplikasi(),
    namaDatabase: namaDb ? `${namaDb} (PostgreSQL)` : 'PostgreSQL',
    ukuranDb,
    waktuDatabase: new Date().toISOString(),
    migrasi,
    ringkasan: [
      { nama: 'Produk', jumlah: await hitung('SELECT COUNT(*) AS n FROM products') },
      { nama: 'Toko', jumlah: await hitung('SELECT COUNT(*) AS n FROM stores') },
      { nama: 'Gudang', jumlah: await hitung('SELECT COUNT(*) AS n FROM warehouses') },
      { nama: 'Pelanggan', jumlah: await hitung('SELECT COUNT(*) AS n FROM customers') },
      { nama: 'Pemasok', jumlah: await hitung('SELECT COUNT(*) AS n FROM suppliers') },
      { nama: 'Penjualan (faktur)', jumlah: await hitung(`SELECT COUNT(*) AS n FROM invoices WHERE jenis = 'penjualan'`) },
      { nama: 'Pembelian', jumlah: await hitung('SELECT COUNT(*) AS n FROM purchases') },
      { nama: 'Jurnal', jumlah: await hitung('SELECT COUNT(*) AS n FROM journals') },
      { nama: 'Akun (COA)', jumlah: await hitung('SELECT COUNT(*) AS n FROM accounts') },
      { nama: 'Pengguna', jumlah: await hitung('SELECT COUNT(*) AS n FROM users') },
      { nama: 'Baris Log Aktivitas', jumlah: await hitung('SELECT COUNT(*) AS n FROM audit_logs') },
    ],
  };
}

export interface BarisBackup {
  nama: string;
  ukuran: number;
  waktu: string;
}

/** Daftar berkas cadangan, terbaru lebih dulu. */
export function daftarBackup(): BarisBackup[] {
  try {
    if (!fs.existsSync(LOKASI_BACKUP)) return [];
    return fs
      .readdirSync(LOKASI_BACKUP)
      .filter((f) => f.endsWith(EKSTENSI_CADANGAN))
      .map((f) => {
        const p = path.join(LOKASI_BACKUP, f);
        const st = fs.statSync(p);
        return { nama: f, ukuran: st.size, waktu: st.mtime.toISOString() };
      })
      .sort((a, b) => (a.waktu < b.waktu ? 1 : -1));
  } catch {
    return [];
  }
}

const AMAN = /^[A-Za-z0-9._-]+\.dump$/;

/** Buat satu cadangan. Mengembalikan nama berkas hasil cadangan. */
export async  function buatBackup(alasan: string): Promise<string> {
  const url = pastikanDatabaseUrl();
  fs.mkdirSync(LOKASI_BACKUP, { recursive: true });
  // Nama harus unik: dua cadangan bisa dibuat dalam detik yang sama
  // (mis. cadangan pengaman saat pemulihan langsung mengikuti cadangan manual).
  const stempel = new Date().toISOString().replace(/[:.]/g, '-');
  let nama = `backup-${stempel}${EKSTENSI_CADANGAN}`;
  let urut = 1;
  while (fs.existsSync(path.join(LOKASI_BACKUP, nama))) {
    nama = `backup-${stempel}-${urut++}${EKSTENSI_CADANGAN}`;
  }
  const tujuan = path.join(LOKASI_BACKUP, nama);
  // pg_dump format custom: konsisten tanpa mengunci tulis, satu berkas ringkas.
  try {
    await execFileAsync(cariBiner('pg_dump'), ['--dbname=' + url, '--format=custom', '--no-owner', '--file=' + tujuan]);
  } catch (e) {
    throw tolak(500, `Cadangan gagal dibuat — pastikan perkakas PostgreSQL (pg_dump) terpasang. (${pesanGalat(e)})`);
  }
  if (!fs.existsSync(tujuan) || ukuranBerkas(tujuan) === 0) {
    throw tolak(500, 'Cadangan gagal dibuat — periksa izin folder data/backups.');
  }
  void alasan;
  await bersihkanCadanganLama();
  return nama;
}

function pesanGalat(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message).slice(0, 200);
  return String(e).slice(0, 200);
}

/** Simpan hanya N cadangan terbaru (mengikuti pengaturan jumlah backup). */
export async  function bersihkanCadanganLama(): Promise<void> {
  const batas = Math.max(1, Math.min(100, await bacaJumlahCadangan()));
  const daftar = daftarBackup();
  for (const b of daftar.slice(batas)) {
    try {
      fs.unlinkSync(path.join(LOKASI_BACKUP, b.nama));
    } catch {
      /* berkas terkunci — biarkan */
    }
  }
}

export async function bacaJumlahCadangan(): Promise<number> {
  const v = await ((await all<{ nilai: string | null }>(`SELECT nilai FROM settings WHERE kunci = 'peng.database.jumlah_backup'`)))[0]?.nilai;
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 14;
}

/** Path berkas cadangan — hanya nama aman yang boleh diminta. */
export function pathBackup(nama: string): string {
  if (!AMAN.test(nama)) throw tolak(400, 'Nama berkas cadangan tidak valid.');
  const p = path.join(LOKASI_BACKUP, nama);
  if (!fs.existsSync(p)) throw tolak(404, `Cadangan "${nama}" tidak ditemukan.`);
  return p;
}

/**
 * Pulihkan database dari cadangan.
 *
 * PERINGATAN: menimpa seluruh isi database aktif dengan isi cadangan.
 *
 * Isi disalin TABEL PER TABEL di dalam satu transaksi, bukan dengan menimpa
 * berkas database. Menimpa berkas di bawah koneksi SQLite yang sedang terbuka
 * membuat koneksi terus menulis ke berkas lama dan merusak disk image —
 * jadi salinan dilakukan lewat SQLite sendiri agar aman saat aplikasi berjalan.
 */
export async  function pulihkanBackup(nama: string): Promise<void> {
  await pulihkanDariBerkas(pathBackup(nama));
}

/** Awalan ajaib berkas pg_dump format custom ("PGDMP") — validasi isi, bukan sekadar ekstensi. */
const SULAP_PGDMP = Buffer.from('PGDMP', 'ascii');

function berkasCadanganValid(p: string): void {
  let fd: number | null = null;
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size < 16) throw tolak(409, 'Berkas cadangan rusak atau kosong. Pulihkan dari cadangan lain.');
    fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(5);
    fs.readSync(fd, buf, 0, 5, 0);
    if (!buf.equals(SULAP_PGDMP)) {
      throw tolak(409, 'Berkas bukan cadangan PostgreSQL yang valid (diterima: .dump hasil backup aplikasi).');
    }
  } catch (e) {
    if (e && typeof e === 'object' && 'status' in e) throw e;
    throw tolak(409, 'Berkas cadangan tidak dapat dibaca. Pulihkan dari cadangan lain.');
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* abaikan */ } }
  }
}

/**
 * Pulihkan database aktif dari BERKAS cadangan pg_dump (.dump) apa pun
 * (bukan hanya folder cadangan) — dipakai alur Restore dari unggahan.
 * pg_restore --single-transaction: gagal di tengah jalan = tergulung =
 * database lama utuh. Skema ikut dipulihkan dari cadangan (--clean),
 * sehingga hasilnya sama persis dengan saat cadangan dibuat.
 */
export async function pulihkanDariBerkas(sumber: string): Promise<void> {
  const url = pastikanDatabaseUrl();
  berkasCadanganValid(sumber);
  try {
    await execFileAsync(cariBiner('pg_restore'), [
      '--dbname=' + url, '--clean', '--if-exists', '--no-owner', '--single-transaction', sumber,
    ]);
  } catch (e) {
    throw tolak(409, `Pemulihan gagal — database tidak diubah. (${pesanGalat(e)})`);
  }
}


/**
 * Restore database dari berkas yang DIUNGGAH pengguna (alur tombol "Restore
 * Database"). Terisolasi dari alur backup/vacuum/reindex: memakai inti
 * yang sama dengan pulihkanBackup sehingga perilaku transaksional identik.
 *
 * Langkah: validasi isi pg_dump (.dump) → tulis berkas sementara →
 * cadangan pengaman otomatis dari database aktif → pulihkan
 * (satu transaksi; gagal = tergulung otomatis, database lama utuh) →
 * hapus berkas sementara.
 * Mengembalikan nama cadangan pengaman (untuk audit/pesan).
 */
export async  function pulihkanDariUnggahan(isi: Buffer, namaAsli: string): Promise<string> {
  const ekstensi = String(namaAsli ?? '').toLowerCase();
  if (!ekstensi.endsWith(EKSTENSI_CADANGAN)) {
    throw tolak(400, `Ekstensi berkas tidak didukung. Unggah cadangan PostgreSQL (${EKSTENSI_CADANGAN} hasil backup aplikasi).`);
  }
  if (!isi || isi.length < 16 || !isi.subarray(0, 5).equals(SULAP_PGDMP)) {
    throw tolak(400, `Berkas bukan cadangan PostgreSQL yang valid (diterima: ${EKSTENSI_CADANGAN} hasil backup aplikasi).`);
  }
  fs.mkdirSync(LOKASI_BACKUP, { recursive: true });
  const stempel = new Date().toISOString().replace(/[:.]/g, '-');
  const temp = path.join(LOKASI_BACKUP, `unggah-${stempel}${EKSTENSI_CADANGAN}`);
  try {
    fs.writeFileSync(temp, isi);
    const pengaman = await buatBackup('pengaman-sebelum-restore-unggah');
    await pulihkanDariBerkas(temp);
    return pengaman;
  } finally {
    try { fs.unlinkSync(temp); } catch { /* berkas sementara — abaikan */ }
  }
}

/* ------------------------- Pemeriksaan pembaruan ------------------------- */

/**
 * Pemeriksaan pembaruan.
 *
 * Aplikasi belum memiliki endpoint pembaruan resmi, jadi jawabannya jujur:
 * `tersedia: false` dengan petunjuk cara memeriksa manual. Tidak ada panggilan
 * jaringan yang dibuat (tidak ada izin & tidak ada endpoint yang diketahui).
 */
/* ---------------- Perawatan database (Vacuum & Re Index) ---------------- */

export type ModeRawat = 'standar' | 'penuh' | 'reindex';

const LABEL_RAWAT: Record<ModeRawat, string> = {
  standar: 'Vacuum Standard',
  penuh: 'Vacuum Full',
  reindex: 'Re Index',
};

/**
 * Perawatan database PostgreSQL sesuai templat Pengaturan Database:
 * - standar: VACUUM (ANALYZE) — cepat, merampingkan + perbarui statistik.
 * - penuh: VACUUM (FULL) — membangun ulang seluruh tabel (lebih lama, kunci tulis).
 * - reindex: REINDEX per tabel pengguna — membangun ulang seluruh indeks.
 * Ukuran sebelum/sesudah = pg_database_size. Lakukan saat tidak ada
 * transaksi berjalan / tutup toko.
 */
export async function rawatDatabase(mode: ModeRawat): Promise<{ sebelum: number; sesudah: number; durasiMs: number }> {
  const label = LABEL_RAWAT[mode];
  if (!label) throw tolak(400, 'Mode perawatan tidak dikenal.');
  const ukuranDb = async (): Promise<number> => {
    try {
      return Number((await get<{ ukuran: number }>(`SELECT pg_database_size(current_database()) AS ukuran`))?.ukuran ?? 0);
    } catch {
      return 0;
    }
  };
  const sebelum = await ukuranDb();
  const mulai = Date.now();
  // VACUUM / REINDEX tidak boleh di dalam transaksi — run() memakai koneksi
  // autocommit sehingga aman dipanggil langsung (sama seperti semula).
  if (mode === 'standar') {
    await run('VACUUM (ANALYZE)');
  } else if (mode === 'penuh') {
    await run('VACUUM (FULL, ANALYZE)');
  } else {
    const tabel = await all<{ nama: string }>(
      `SELECT tablename AS nama FROM pg_tables WHERE schemaname = 'public'`,
    );
    for (const t of tabel) {
      await run(`REINDEX TABLE "${t.nama.replace(/"/g, '""')}"`);
    }
  }
  return { sebelum, sesudah: await ukuranDb(), durasiMs: Date.now() - mulai };
}

export function periksaPembaruan(): { versi: string; tersedia: boolean; pesan: string } {
  const versi = versiAplikasi();
  return {
    versi,
    tersedia: false,
    pesan: `Versi terpasang ${versi}. Aplikasi ini belum memiliki kanal pembaruan otomatis — periksa repositori atau distributor resmi Anda untuk versi terbaru.`,
  };
}
