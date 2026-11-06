import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { beritahu } from '../../components/crud/Toast';
import { Icon } from '../../components/Icon';
import { IconButton } from '../../components/IconButton';
import { Modal } from '../../components/crud/Modal';
import { apiDelete, apiGet, apiPost, apiPut } from '../../lib/api';
import { useSegarkanModul } from '../../lib/segarkan';
import { formatAngka, formatTanggalPanjang } from '../../lib/format';
import { useIdentitas } from '../../lib/identitas';
import { useSesi } from '../../lib/sesi';
import { PanelResetData } from './PanelResetData';

const fmtUkuran = (b: number): string =>
  b >= 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`;

/** Panel data yang belum tersedia — menampilkan petunjuk, bukan galat. */
function Kosong({ judul, pesan }: { judul: string; pesan: string }) {
  return (
    <section className="kartu">
      <div className="kartu__kepala kartu__kepala--kompak">
        <h3>{judul}</h3>
      </div>
      <p className="teks-redup">{pesan}</p>
    </section>
  );
}

/* =================== Grup Keuangan ▸ Kas & Bank ======================= */

interface RekKas {
  id: number;
  kode: string;
  nama: string;
  jenis: 'kas' | 'bank' | 'e-wallet';
  aktif: number;
}

interface MetodeBayar {
  metode: string;
  cash_account_id: number;
  akun_nama: string;
}

const JENIS_LABEL: Record<string, string> = { kas: 'Kas', bank: 'Bank', 'e-wallet': 'E-Wallet' };
const METODE_LABEL: Record<string, string> = { tunai: 'Tunai', transfer: 'Transfer', qris: 'QRIS / EDC' };

/**
 * Kas & Bank (Akuntansi Dasar): rekening bawaan per metode bayar (tunai/
 * transfer/qris → rekening kas) — penjualan tunai & pembayaran piutang/hutang
 * otomatis memakai rekening ini. Kategori biaya & pemasukan juga dikelola di
 * halaman Akuntansi ▸ Pengeluaran / Pemasukan Lain.
 */
export function PanelKasBank({ nilai }: { nilai: Record<string, unknown> }) {
  const [rek, setRek] = useState<RekKas[]>([]);
  const [metode, setMetode] = useState<MetodeBayar[]>([]);
  const [sibuk, setSibuk] = useState(false);
  const daftarMetode = Array.isArray(nilai.metode_bayar) ? (nilai.metode_bayar as string[]) : ['tunai', 'transfer', 'qris'];

  const muat = useCallback(async () => {
    const r = await apiGet<{ data: RekKas[] }>('/api/akuntansi/kas/akun').catch(() => ({ data: [] as RekKas[] }));
    setRek(r.data.filter((a) => a.aktif !== 0));
    const m = await apiGet<{ data: MetodeBayar[] }>('/api/akuntansi/metode-bayar').catch(() => ({ data: [] as MetodeBayar[] }));
    setMetode(m.data);
  }, []);

  useEffect(() => {
    void muat();
  }, [muat]);
  // Tombol Refresh global di topbar: muat ulang data panel ini.
  useSegarkanModul(muat);

  const simpanMetode = async (m: string, akunId: number) => {
    setSibuk(true);
    try {
      await apiPut('/api/akuntansi/metode-bayar', { metode: m, akun_id: akunId });
      beritahu(`Metode bayar "${METODE_LABEL[m] ?? m}" ditautkan ke rekening.`);
      await muat();
    } catch (e) {
      beritahu(e instanceof Error ? e.message : 'Gagal menyimpan pemetaan metode bayar.', 'galat');
    } finally {
      setSibuk(false);
    }
  };

  if (rek.length === 0) {
    return (
      <Kosong
        judul="Rekening Kas & Bank"
        pesan="Belum ada rekening kas/bank. Tambahkan lewat Akuntansi ▸ Kas & Bank — penjualan tunai dan pembayaran piutang/hutang otomatis memakai rekening sesuai metode bayar."
      />
    );
  }

  return (
    <section className="kartu">
      <div className="kartu__kepala kartu__kepala--kompak">
        <h3>Rekening per Metode Bayar</h3>
        <Link to="/akuntansi/kas" className="teks-redup">
          Kelola rekening di Kas &amp; Bank →
        </Link>
      </div>
      <p className="teks-redup">
        Penjualan tunai &amp; pembayaran piutang menambah Kas Masuk; pembelian &amp; pembayaran hutang menjadi Kas Keluar —
        memakai rekening di bawah ini sesuai metode bayar.
      </p>
      <div className="form-grid">
        {daftarMetode.map((m) => {
          const aktif = metode.find((x) => x.metode === m)?.cash_account_id ?? '';
          return (
            <div className="bidang" key={m}>
              <label htmlFor={`mb-${m}`}>{METODE_LABEL[m] ?? m}</label>
              <select
                id={`mb-${m}`}
                value={aktif}
                disabled={sibuk}
                onChange={(e) => void simpanMetode(m, Number(e.target.value))}
              >
                <option value="">— pilih rekening —</option>
                {rek.map((a) => (
                  <option key={a.id} value={a.id}>{a.kode} · {a.nama}</option>
                ))}
              </select>
            </div>
          );
        })}
      </div>
      <h4 className="teks-redup" style={{ marginTop: 14 }}>Rekening kas/bank aktif</h4>
      <table className="aturan-tabel">
        <thead>
          <tr>
            <th>Kode</th>
            <th>Nama</th>
            <th>Jenis</th>
          </tr>
        </thead>
        <tbody>
          {rek.map((a) => (
            <tr key={a.id}>
              <td><strong>{a.kode}</strong></td>
              <td>{a.nama}</td>
              <td>{JENIS_LABEL[a.jenis] ?? a.jenis}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/* ================= Grup Keamanan & Sistem ▸ 16. Keamanan ================ */

interface BarisSesi {
  id: number;
  perangkat: string | null;
  terakhir: string;
  ip: string | null;
  nama: string;
  username: string;
}

interface StatusKode {
  ada: boolean;
  dibuat: number;
  sisa: number;
  waktu: string | null;
}

/**
 * TAHAP 1 & 2 — Keamanan:
 *  • daftar sesi/perangkat aktif + Keluar Paksa per sesi (ada penanda
 *    "Sesi ini" supaya Admin tidak salah mengeluarkan dirinya sendiri),
 *  • Kode Pemulihan Admin utama: 10 kode sekali pakai — tampil SEKALI saat
 *    dibuat, dengan salin/unduh.
 */
export function PanelKeamanan() {
  const { info } = useSesi();
  const sesiSaya = info?.sesiId ?? null;
  const admin = info?.pengguna.admin ?? false;

  const [baris, setBaris] = useState<BarisSesi[] | null>(null);
  const [status, setStatus] = useState<StatusKode | null>(null);
  const [kodeBaru, setKodeBaru] = useState<string[] | null>(null);
  const [keluarTarget, setKeluarTarget] = useState<BarisSesi | null>(null);
  const [sibuk, setSibuk] = useState(false);

  const muat = useCallback(async () => {
    try {
      const r = await apiGet<{ data: BarisSesi[] }>('/api/pengaturan/keamanan/sesi');
      setBaris(r.data);
    } catch {
      setBaris([]);
    }
    try {
      setStatus(await apiGet<StatusKode>('/api/pengaturan/keamanan/kode-pemulihan'));
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void muat();
  }, [muat]);
  // Tombol Refresh global di topbar: muat ulang data panel ini.
  useSegarkanModul(muat);

  async function keluarkan(b: BarisSesi) {
    setSibuk(true);
    try {
      const r = await apiDelete<{ pesan: string }>(`/api/pengaturan/keamanan/sesi/${b.id}`);
      beritahu(r.pesan);
      setKeluarTarget(null);
      await muat();
    } catch (e) {
      beritahu(e instanceof Error ? e.message : 'Gagal mengeluarkan sesi.', 'galat');
    } finally {
      setSibuk(false);
    }
  }

  async function buatKode() {
    setSibuk(true);
    try {
      const r = await apiPost<{ kode: string[]; pesan: string }>('/api/pengaturan/keamanan/kode-pemulihan', {});
      setKodeBaru(r.kode);
      beritahu(r.pesan);
      await muat();
    } catch (e) {
      beritahu(e instanceof Error ? e.message : 'Gagal membuat Kode Pemulihan.', 'galat');
    } finally {
      setSibuk(false);
    }
  }

  async function salinKode() {
    try {
      await navigator.clipboard.writeText((kodeBaru ?? []).join('\n'));
      beritahu('Kesepuluh kode disalin ke papan klip.');
    } catch {
      beritahu('Peramban menolak papan klip — gunakan tombol Unduh.', 'galat');
    }
  }

  function unduhKode() {
    const isi =
      `Kode Pemulihan — ${formatTanggalPanjang(new Date().toISOString())}\n\n` +
      `${(kodeBaru ?? []).join('\n')}\n\n` +
      'Simpan di tempat aman. Tiap kode hanya bisa dipakai sekali untuk menyetel ulang password Admin utama.\n';
    const url = URL.createObjectURL(new Blob([isi], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'kode-pemulihan.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  if (baris === null) return <p className="teks-redup">Memuat sesi…</p>;

  return (
    <>
      <section className="kartu">
        <div className="kartu__kepala kartu__kepala--kompak">
          <h3>Perangkat &amp; Sesi Aktif</h3>
          <span className="teks-redup">Keluarkan paksa perangkat yang tidak dikenali.</span>
        </div>
        {baris.length === 0 ? (
          <p className="teks-redup">Belum ada sesi aktif — tidak ada perangkat yang sedang masuk saat ini.</p>
        ) : (
          <table className="aturan-tabel">
            <thead>
              <tr>
                <th>Pengguna</th>
                <th>Perangkat</th>
                <th>Alamat IP</th>
                <th>Terakhir aktif</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {baris.map((s) => (
                <tr key={s.id}>
                  <td>
                    <strong>{s.nama}</strong>
                    <div className="teks-redup teks-kecil">{s.username}</div>
                  </td>
                  <td>
                    {s.perangkat ?? '—'}
                    {s.id === sesiSaya && (
                      <span className="lencana lencana--aktif" style={{ marginLeft: 6 }}>
                        Sesi ini
                      </span>
                    )}
                  </td>
                  <td>{s.ip ?? '—'}</td>
                  <td>{formatTanggalPanjang(s.terakhir)}</td>
                  <td>
                    <IconButton
                      label={s.id === sesiSaya ? 'Keluar dari sesi ini' : 'Keluarkan paksa'}
                      ikon="power"
                      onClick={() => setKeluarTarget(s)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="kartu">
        <div className="kartu__kepala kartu__kepala--kompak">
          <h3>Kode Pemulihan Admin</h3>
          {admin ? (
            <button type="button" className="tombol tombol--kecil" disabled={sibuk} onClick={() => void buatKode()}>
              {sibuk ? 'Membuat…' : 'Buat 10 kode baru'}
            </button>
          ) : (
            <span className="teks-redup">Hanya Admin yang bisa membuat kode baru.</span>
          )}
        </div>
        <p className="teks-redup">
          Kode Pemulihan dipakai saat lupa password dan email/WhatsApp belum tersambung: masukkan satu kode di
          halaman Lupa password untuk membuat password baru. Membuat kode baru otomatis membatalkan kode lama.
        </p>
        {status === null ? (
          <p className="teks-redup">Status kode belum tersedia.</p>
        ) : (
          <dl className="info-sistem">
            <div>
              <dt>Pernah dibuat</dt>
              <dd>{status.ada ? `${status.dibuat} kode` : 'Belum pernah'}</dd>
            </div>
            <div>
              <dt>Sisa belum dipakai</dt>
              <dd>{status.sisa}</dd>
            </div>
            <div>
              <dt>Dibuat terakhir</dt>
              <dd>{status.waktu ? formatTanggalPanjang(status.waktu) : '—'}</dd>
            </div>
          </dl>
        )}
      </section>

      {keluarTarget && (
        <Modal
          judul="Keluarkan sesi"
          lebar="kecil"
          onTutup={() => setKeluarTarget(null)}
          sedangKirim={sibuk}
          aksi={
            <>
              <button type="button" className="tombol tombol--netral" onClick={() => setKeluarTarget(null)} disabled={sibuk}>
                Batal
              </button>
              <button type="button" className="tombol tombol--bahaya" onClick={() => void keluarkan(keluarTarget)} disabled={sibuk}>
                {sibuk ? 'Mengeluarkan…' : 'Keluarkan'}
              </button>
            </>
          }
        >
          <p>
            Keluarkan sesi <strong>{keluarTarget.nama}</strong> ({keluarTarget.username}) di perangkat{' '}
            <strong>{keluarTarget.perangkat ?? 'tanpa nama'}</strong>?
            {keluarTarget.id === sesiSaya && ' Ini adalah sesi Anda sendiri — Anda akan keluar dari aplikasi.'}
          </p>
          <p className="teks-redup">Perangkat tersebut harus masuk kembali dengan password setelah dikeluarkan.</p>
        </Modal>
      )}

      {kodeBaru && (
        <Modal
          judul="Kode Pemulihan — tampil sekali"
          lebar="sedang"
          onTutup={() => setKodeBaru(null)}
          aksi={
            <>
              <button type="button" className="tombol tombol--netral" onClick={unduhKode}>
                Unduh .txt
              </button>
              <button type="button" className="tombol" onClick={() => void salinKode()}>
                Salin semua
              </button>
              <button type="button" className="tombol tombol--primer" onClick={() => setKodeBaru(null)}>
                Sudah saya simpan
              </button>
            </>
          }
        >
          <p className="peringatan-dampak">
            Kesepuluh kode ini HANYA tampil sekali ini dan tidak bisa dilihat lagi. Simpan di tempat aman
            (cetak/unduh) sekarang juga — tiap kode hanya bisa dipakai satu kali.
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: 8,
              fontFamily: 'ui-monospace, monospace',
              fontSize: 14,
              letterSpacing: '0.05em',
            }}
          >
            {kodeBaru.map((k) => (
              <span
                key={k}
                style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', textAlign: 'center' }}
              >
                {k}
              </span>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}

/* =============== Keamanan & Sistem ▸ 18. Database & Backup ============== */

interface InfoSistem {
  versi: string; namaDatabase: string; ukuranDb: number; waktuDatabase: string;
  migrasi: number; ringkasan: { nama: string; jumlah: number }[];
  cadangan: { nama: string; ukuran: number; waktu: string }[];
}

/** Info database, cadangan manual/terjadwal, dan pemulihan (dengan peringatan). */
type ModeRawat = 'standar' | 'penuh' | 'reindex';

const TOMBOL_RAWAT: { mode: ModeRawat; label: string; tanya: string }[] = [
  { mode: 'standar', label: 'Vacuum Standard', tanya: 'Jalankan Vacuum Standard?' },
  { mode: 'penuh', label: 'Vacuum Full', tanya: 'Jalankan Vacuum Full? Proses ini lebih lama dan mengunci tulis database.' },
  { mode: 'reindex', label: 'Re Index', tanya: 'Jalankan Re Index (membangun ulang seluruh indeks)?' },
];

export function PanelDatabase({ nilai }: { nilai: Record<string, unknown> }) {
  const [info, setInfo] = useState<InfoSistem | null>(null);
  const [pulih, setPulih] = useState<string | null>(null);
  const [konfirmasi, setKonfirmasi] = useState('');
  // Restore dari unggahan — terisolasi dari alur pulihkan-cadangan.
  const [unggah, setUnggah] = useState<File | null>(null);
  const [konfirmasiUnggah, setKonfirmasiUnggah] = useState('');
  const [unggahSibuk, setUnggahSibuk] = useState(false);
  const pemilihBerkas = useRef<HTMLInputElement | null>(null);
  const [rawatSibuk, setRawatSibuk] = useState<ModeRawat | null>(null);

  const muat = useCallback(async () => {
    try {
      setInfo(await apiGet<InfoSistem>('/api/pengaturan/sistem/info'));
    } catch (e) {
      beritahu(e instanceof Error ? e.message : 'Gagal memuat info database.', 'galat');
    }
  }, []);

  useEffect(() => {
    void muat();
  }, [muat]);
  // Tombol Refresh global di topbar: muat ulang data panel ini.
  useSegarkanModul(muat);

  async function cadangkan() {
    try {
      const r = await apiPost<{ pesan: string }>('/api/pengaturan/sistem/backup', {});
      beritahu(r.pesan);
      await muat();
    } catch (e) {
      beritahu(e instanceof Error ? e.message : 'Gagal membuat cadangan.', 'galat');
    }
  }

  async function rawat(mode: ModeRawat, label: string, tanya: string) {
    if (rawatSibuk !== null) return;
    if (!window.confirm(`${tanya} Pastikan tidak ada transaksi yang sedang berlangsung.`)) return;
    setRawatSibuk(mode);
    try {
      const r = await apiPost<{ pesan: string }>('/api/pengaturan/sistem/rawat', { mode });
      beritahu(r.pesan, 'sukses');
      await muat();
    } catch (e) {
      beritahu(e instanceof Error ? e.message : `Gagal menjalankan ${label}.`, 'galat');
    } finally {
      setRawatSibuk(null);
    }
  }

  function pilihBerkasRestore(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    e.target.value = ''; // boleh pilih berkas yang sama berulang kali
    if (!f) return;
    if (!/\.(db|sqlite|sqlite3)$/i.test(f.name)) {
      beritahu('Berkas bukan database SQLite (.db/.sqlite/.sqlite3).', 'galat');
      return;
    }
    setUnggah(f);
    setKonfirmasiUnggah('');
  }

  async function restoreUnggahan() {
    if (!unggah || unggahSibuk) return;
    setUnggahSibuk(true);
    try {
      const res = await fetch(
        `/api/pengaturan/sistem/pulihkan-unggah?nama=${encodeURIComponent(unggah.name)}&konfirmasi=${encodeURIComponent(konfirmasiUnggah)}`,
        { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: unggah },
      );
      let data: { pesan?: string } | null = null;
      try { data = (await res.json()) as { pesan?: string }; } catch { /* bukan JSON */ }
      if (!res.ok) throw new Error(data?.pesan ?? `Gagal restore (HTTP ${res.status}).`);
      beritahu(data?.pesan ?? 'Database berhasil dipulihkan. Halaman akan dimuat ulang.');
      setUnggah(null);
      setKonfirmasiUnggah('');
      window.setTimeout(() => window.location.reload(), 1500);
    } catch (e) {
      beritahu(e instanceof Error ? e.message : 'Gagal restore dari berkas.', 'galat');
    } finally {
      setUnggahSibuk(false);
    }
  }

  async function pulihkan(nama: string) {
    try {
      const r = await apiPost<{ pesan: string }>('/api/pengaturan/sistem/pulihkan', { nama, konfirmasi });
      beritahu(r.pesan);
      setPulih(null);
      setKonfirmasi('');
      await muat();
    } catch (e) {
      beritahu(e instanceof Error ? e.message : 'Gagal memulihkan.', 'galat');
    }
  }

  if (!info) return <p className="teks-redup">Memuat info database…</p>;

  return (
    <>
      <section className="kartu">
        <div className="kartu__kepala kartu__kepala--kompak">
          <h3>Database Aktif</h3>
          <span className="aksi-baris">
            <IconButton label="Restore dari berkas…" ikon="upload" onClick={() => pemilihBerkas.current?.click()} />
            <IconButton label="Buat cadangan sekarang" ikon="download" onClick={() => void cadangkan()} />
          </span>
          <input ref={pemilihBerkas} type="file" accept=".db,.sqlite,.sqlite3" hidden onChange={pilihBerkasRestore} />
        </div>
        <dl className="info-sistem">
          <div><dt>Berkas</dt><dd>{info.namaDatabase}</dd></div>
          <div><dt>Ukuran</dt><dd>{fmtUkuran(info.ukuranDb)}</dd></div>
          <div><dt>Perubahan terakhir</dt><dd>{info.waktuDatabase ? formatTanggalPanjang(info.waktuDatabase) : '—'}</dd></div>
          <div><dt>Migrasi diterapkan</dt><dd>{info.migrasi}</dd></div>
          <div><dt>Jadwal backup</dt><dd>{String(nilai.backup_otomatis ?? 'mati')} {String(nilai.backup_otomatis ?? 'mati') !== 'mati' ? `pukul ${String(nilai.backup_jam ?? '02:00')}` : ''}</dd></div>
          <div><dt>Disimpan</dt><dd>{info.cadangan.length} / {String(nilai.jumlah_backup ?? 14)} berkas</dd></div>
        </dl>
      </section>

      <section className="kartu">
        <div className="kartu__kepala kartu__kepala--kompak">
          <h3>Pengaturan Database</h3>
        </div>
        <div className="db-rawat-info" role="note">
          <p className="db-rawat-judul"><span aria-hidden="true">💡</span> INFORMASI :</p>
          <ul>
            <li><strong>Vacuum Standard :</strong> Merampingkan ukuran database, dengan menghapus hasil proses perhitungan database yang tidak berguna, Sehingga akan dapat mempercepat kinerja database.</li>
            <li><strong>Vacuum Full :</strong> Sama seperti vacuum standard, pada vacuum full prosesnya lebih lama.</li>
            <li><strong>Re Index :</strong> Membuat Index ulang yaitu mengatur index data sehingga menunjang algoritma dari database agar lebih cepat dalam pencarian data.</li>
          </ul>
          <p>Lakukan proses ini ketika sudah tidak ada transaksi yang sedang berlangsung atau saat tutup toko.</p>
        </div>
        <div className="db-rawat-tombol">
          {TOMBOL_RAWAT.map((t) => (
            <button
              key={t.mode}
              type="button"
              className="tombol"
              disabled={rawatSibuk !== null}
              onClick={() => void rawat(t.mode, t.label, t.tanya)}
            >
              <Icon nama="sliders" size={15} />
              {rawatSibuk === t.mode ? 'Memproses…' : t.label}
            </button>
          ))}
        </div>
      </section>

      <section className="kartu">
        <div className="kartu__kepala kartu__kepala--kompak">
          <h3>Riwayat Cadangan</h3>
          <span className="teks-redup">Unduh atau pulihkan.</span>
        </div>
        {info.cadangan.length === 0 ? (
          <p className="teks-redup">Belum ada cadangan. Klik ikon unduh di atas untuk membuat cadangan pertama.</p>
        ) : (
          <table className="aturan-tabel">
            <thead>
              <tr><th>Nama berkas</th><th>Ukuran</th><th>Dibuat</th><th /></tr>
            </thead>
            <tbody>
              {info.cadangan.map((c) => (
                <tr key={c.nama}>
                  <td>{c.nama}</td>
                  <td>{fmtUkuran(c.ukuran)}</td>
                  <td>{formatTanggalPanjang(c.waktu)}</td>
                  <td>
                    <span className="aksi-baris">
                      <a className="tombol tombol--kecil" href={`/api/pengaturan/sistem/backup/unduh?nama=${encodeURIComponent(c.nama)}`}>
                        Unduh
                      </a>
                      <IconButton label={`Pulihkan dari ${c.nama}`} ikon="rotate-ccw" onClick={() => setPulih(c.nama)} />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Reset Data — wizard 4 langkah, hanya Admin utama (panel & server). */}
      {unggah && (
        <section className="kartu kartu--bahaya">
          <div className="kartu__kepala kartu__kepala--kompak">
            <h3>Restore dari berkas “{unggah.name}”</h3>
          </div>
          <p className="peringatan-dampak">
            Proses Restore akan menimpa seluruh data database saat ini dengan data dari berkas yang diunggah.
            Tindakan ini tidak dapat dibatalkan. Sebelum melanjutkan, sebuah cadangan pengaman dari keadaan
            sekarang dibuat otomatis.
          </p>
          <div className="bidang">
            <label htmlFor="konf-restore-unggah">Ketik <strong>PULIHKAN</strong> untuk melanjutkan</label>
            <input id="konf-restore-unggah" value={konfirmasiUnggah} onChange={(e) => setKonfirmasiUnggah(e.target.value)} autoComplete="off" disabled={unggahSibuk} />
          </div>
          <div className="tombol-baris tombol-baris--kanan">
            <button type="button" className="tombol tombol--netral" disabled={unggahSibuk} onClick={() => { setUnggah(null); setKonfirmasiUnggah(''); }}>
              Batal
            </button>
            <button type="button" className="tombol tombol--bahaya" disabled={konfirmasiUnggah !== 'PULIHKAN' || unggahSibuk} onClick={() => void restoreUnggahan()}>
              {unggahSibuk ? 'Memulihkan…' : 'Ya, Restore Database'}
            </button>
          </div>
        </section>
      )}

      <PanelResetData />

      {pulih && (
        <section className="kartu kartu--bahaya">
          <div className="kartu__kepala kartu__kepala--kompak">
            <h3>Pulihkan dari “{pulih}”</h3>
          </div>
          <p className="peringatan-dampak">
            Peringatan: pemulihan menimpa SELURUH isi database aktif dengan isi cadangan ini.
            Data yang dibuat setelah cadangan dibuat akan hilang. Sebelum melanjutkan, sebuah
            cadangan pengaman dari keadaan sekarang dibuat otomatis.
          </p>
          <div className="bidang">
            <label htmlFor="konf-pulih">Ketik <strong>PULIHKAN</strong> untuk melanjutkan</label>
            <input id="konf-pulih" value={konfirmasi} onChange={(e) => setKonfirmasi(e.target.value)} autoComplete="off" />
          </div>
          <div className="tombol-baris tombol-baris--kanan">
            <button type="button" className="tombol tombol--netral" onClick={() => { setPulih(null); setKonfirmasi(''); }}>
              Batal
            </button>
            <button
              type="button"
              className="tombol tombol--bahaya"
              disabled={konfirmasi !== 'PULIHKAN'}
              onClick={() => void pulihkan(pulih)}
            >
              Pulihkan Sekarang
            </button>
          </div>
        </section>
      )}

      <section className="kartu">
        <div className="kartu__kepala kartu__kepala--kompak">
          <h3>Tutup Tahun</h3>
        </div>
        <p className="teks-redup">
          Penutupan buku tahunan (menghapus riwayat transaksi &amp; membuat saldo awal) dijalankan dari
          modul Proses Tahunan.
        </p>
        <div className="tombol-baris">
          <Link to="/pengaturan/proses-tahunan" className="tombol tombol--netral">
            Buka Proses Tahunan
          </Link>
        </div>
      </section>
    </>
  );
}

/* =============== Keamanan & Sistem ▸ 19. Impor & Ekspor ================= */

interface ModulImpor {
  kode: string; label: string; kolom: { key: string; label: string }[];
  template: string; tersedia: boolean; ket: string | null;
}
interface BarisRiwayat {
  id: number; modul: string; nama_file: string; total_baris: number;
  baris_valid: number; baris_error: number; status: string; waktu: string; nama: string | null;
}

/** Contoh file impor tiap modul + riwayat impor. */
export function PanelImpor() {
  const [modul, setModul] = useState<ModulImpor[]>([]);
  const [riwayat, setRiwayat] = useState<BarisRiwayat[]>([]);

  const muat = useCallback(async () => {
    try {
      const [m, r] = await Promise.all([
        apiGet<{ data: ModulImpor[] }>('/api/pengaturan/impor/modul').catch(() => ({ data: [] as ModulImpor[] })),
        apiGet<{ data: BarisRiwayat[] }>('/api/pengaturan/impor/riwayat').catch(() => ({ data: [] as BarisRiwayat[] })),
      ]);
      setModul(m.data);
      setRiwayat(r.data);
    } catch {
      setModul([]);
      setRiwayat([]);
    }
  }, []);

  useEffect(() => {
    void muat();
  }, [muat]);
  // Tombol Refresh global di topbar: muat ulang data panel ini.
  useSegarkanModul(muat);

  return (
    <>
      <section className="kartu">
        <div className="kartu__kepala kartu__kepala--kompak">
          <h3>Contoh File Impor</h3>
          <span className="teks-redup">Kolom mengikuti skema terbaru.</span>
        </div>
        <table className="aturan-tabel">
          <thead>
            <tr><th>Modul</th><th>Kolom</th><th>Keterangan</th><th /></tr>
          </thead>
          <tbody>
            {modul.map((m) => (
              <tr key={m.kode}>
                <td>{m.label}</td>
                <td>{m.tersedia ? (m.kolom.length || '—') : '—'}</td>
                <td className="teks-redup">
                  {m.ket ?? (m.kolom.length ? `${m.kolom.slice(0, 4).map((k) => k.label).join(', ')}…` : '—')}
                </td>
                <td>
                  {m.tersedia ? (
                    <a className="tombol tombol--kecil" href={m.template}>Unduh contoh</a>
                  ) : (
                    <span className="teks-redup">Tidak tersedia</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="kartu">
        <div className="kartu__kepala kartu__kepala--kompak">
          <h3>Riwayat Impor</h3>
          <IconButton label="Muat ulang riwayat" ikon="rotate-ccw" onClick={() => void muat()} />
        </div>
        {riwayat.length === 0 ? (
          <p className="teks-redup">Belum ada impor yang dijalankan.</p>
        ) : (
          <table className="aturan-tabel">
            <thead>
              <tr><th>Waktu</th><th>Modul</th><th>Berkas</th><th>Baris</th><th>Sah</th><th>Error</th><th>Status</th><th>Oleh</th></tr>
            </thead>
            <tbody>
              {riwayat.map((b) => (
                <tr key={b.id}>
                  <td>{formatTanggalPanjang(b.waktu)}</td>
                  <td>{b.modul}</td>
                  <td>{b.nama_file}</td>
                  <td>{b.total_baris}</td>
                  <td>{b.baris_valid}</td>
                  <td>{b.baris_error}</td>
                  <td>{b.status}</td>
                  <td>{b.nama ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

/* ============== Keamanan & Sistem ▸ 20. Notifikasi & Pesan ============== */

/**
 * Notifikasi & Pesan: status koneksi WhatsApp/email dan pratinjau template.
 *
 * Kedua layanan luar belum tersambung, jadi tombol tes dinonaktifkan dan
 * petunjuk pengaturannya ditampilkan — bukan pesan galat.
 */
export function PanelNotifikasi({ nilai }: { nilai: Record<string, unknown> }) {
  const [tes, setTes] = useState<string | null>(null);

  const waAktif = nilai.wa_aktif === true && String(nilai.wa_nomor_pengirim ?? '') !== '';
  const smtpAktif =
    nilai.smtp_aktif === true &&
    String(nilai.smtp_host ?? '') !== '' &&
    String(nilai.smtp_pengguna ?? '') !== '';

  async function kirimTes(kanal: 'wa' | 'email') {
    try {
      const r = await apiPost<{ pesan: string }>('/api/pengaturan/notifikasi/tes', { kanal });
      setTes(r.pesan);
      beritahu(r.pesan, 'info');
    } catch (e) {
      const pesan = e instanceof Error ? e.message : 'Gagal mengirim tes.';
      setTes(pesan);
      beritahu(pesan, 'galat');
    }
  }

  const variabel = '{NAMA} {NOMOR} {TOTAL} {JATUH_TEMPO}';

  return (
    <>
      <section className="kartu">
        <div className="kartu__kepala kartu__kepala--kompak">
          <h3>Koneksi Kanal Kirim</h3>
        </div>
        <ul className="daftar-kanal">
          <li>
            <strong>WhatsApp</strong>
            <span className={`status-kanal ${waAktif ? 'status-kanal--nyala' : 'status-kanal--mati'}`}>
              {waAktif ? 'Aktif' : 'Belum tersambung'}
            </span>
            <p className="teks-redup">
              Pengiriman otomatis memerlukan akun WhatsApp Business API (Cloud API). Selama belum
              tersambung, kasir mengirim lewat tautan wa.me yang dibuka di WhatsApp perangkat.
            </p>
            <IconButton
              label="Tes kirim WhatsApp"
              ikon="whatsapp"
              disabled={!waAktif}
              alasan={waAktif ? undefined : 'aktifkan & isi nomor dulu'}
              onClick={() => void kirimTes('wa')}
            />
          </li>
          <li>
            <strong>Email (SMTP)</strong>
            <span className={`status-kanal ${smtpAktif ? 'status-kanal--nyala' : 'status-kanal--mati'}`}>
              {smtpAktif ? 'Aktif' : 'Belum tersambung'}
            </span>
            <p className="teks-redup">
              Isi host, port, pengguna, dan kata sandi aplikasi email Anda lalu aktifkan. Dipakai
              untuk mengirim faktur dan tautan reset password.
            </p>
            <IconButton
              label="Tes kirim email"
              ikon="send"
              disabled={!smtpAktif}
              alasan={smtpAktif ? undefined : 'lengkapi SMTP dulu'}
              onClick={() => void kirimTes('email')}
            />
          </li>
        </ul>
        {tes && <p className="teks-redup">{tes}</p>}
      </section>

      <section className="kartu">
        <div className="kartu__kepala kartu__kepala--kompak">
          <h3>Pratinjau Template</h3>
          <span className="teks-redup">Variabel: {variabel}</span>
        </div>
        <div className="form-grid">
          {[
            { k: 'template_faktur', l: 'Faktur' },
            { k: 'template_pengingat', l: 'Pengingat jatuh tempo' },
            { k: 'template_struk', l: 'Struk' },
          ].map((t) => (
            <div className="bidang" key={t.k}>
              <span>{t.l}</span>
              <div className="pratinjau-pesan">{String(nilai[t.k] ?? '')}</div>
            </div>
          ))}
        </div>
        <p className="teks-redup">
          Jadwal pengingat: piutang {String(nilai.pengingat_piutang_hari ?? 3)} hari dan hutang{' '}
          {String(nilai.pengingat_hutang_hari ?? 3)} hari sebelum jatuh tempo.
        </p>
      </section>
    </>
  );
}

/* ================= Keamanan & Sistem ▸ 22. Tentang ====================== */

/** Versi aplikasi, nama database, ringkasan jumlah data, pemeriksaan pembaruan. */
export function PanelTentang() {
  // Y2.4 — identitas aplikasi dari satu sumber data.
  const identitas = useIdentitas();
  const [info, setInfo] = useState<InfoSistem | null>(null);
  const [pembaruan, setPembaruan] = useState<{ versi: string; tersedia: boolean; pesan: string } | null>(null);
  const [sibuk, setSibuk] = useState(false);

  useEffect(() => {
    void apiGet<InfoSistem>('/api/pengaturan/sistem/info').then(setInfo).catch(() => setInfo(null));
  }, []);

  async function periksa() {
    setSibuk(true);
    try {
      setPembaruan(await apiGet<{ versi: string; tersedia: boolean; pesan: string }>('/api/pengaturan/sistem/pembaruan'));
    } catch (e) {
      beritahu(e instanceof Error ? e.message : 'Gagal memeriksa pembaruan.', 'galat');
    } finally {
      setSibuk(false);
    }
  }

  if (!info) return <p className="teks-redup">Memuat info sistem…</p>;

  return (
    <section className="kartu">
      <div className="kartu__kepala kartu__kepala--kompak">
        <h3>Tentang Sistem</h3>
        <IconButton label="Periksa Pembaruan" ikon="rotate-ccw" disabled={sibuk} alasan={sibuk ? 'memeriksa…' : undefined} onClick={() => void periksa()} />
      </div>
      <dl className="info-sistem">
        <div><dt>Aplikasi</dt><dd>{identitas.nama} — {identitas.tagline || 'POS · WMS · Akuntansi'}</dd></div>
        <div><dt>Versi</dt><dd>{info.versi}</dd></div>
        <div><dt>Nama database</dt><dd>{info.namaDatabase}</dd></div>
        <div><dt>Ukuran database</dt><dd>{fmtUkuran(info.ukuranDb)}</dd></div>
        <div><dt>Jumlah migrasi</dt><dd>{info.migrasi}</dd></div>
      </dl>

      <h4 className="teks-redup">Ringkasan jumlah data</h4>
      <div className="ringkasan-data">
        {info.ringkasan.map((r) => (
          <div key={r.nama}>
            <strong>{formatAngka(r.jumlah)}</strong>
            <span>{r.nama}</span>
          </div>
        ))}
      </div>

      {pembaruan && (
        <p className={`teks-redup ${pembaruan.tersedia ? 'pembaruan-tersedia' : ''}`}>{pembaruan.pesan}</p>
      )}
    </section>
  );
}
