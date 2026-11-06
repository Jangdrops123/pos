import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '../../components/crud/Modal';
import { IconButton } from '../../components/IconButton';
import { beritahu } from '../../components/crud/Toast';
import { ambilOpsi, apiDelete, apiGet, apiPost } from '../../lib/api';
import { formatRupiah, formatTanggalWaktu } from '../../lib/format';
import { useSesi } from '../../lib/sesi';
import { DialogWa } from '../faktur/DialogWa';
import {
  cetakStruk,
  pesanWaStruk,
  pratinjauStruk,
  PROFIL_STRUK_BAWAAN,
  simpanStrukPdf,
  type ProfilStruk,
  type StrukData,
} from './struk';
import { bagikanGambar, bisaBagikanGambar, dokKePng, gambarStrukDok } from '../../lib/gambarDok';
import { type BarisKeranjang, type Opsi, type ShiftAktif } from './tipe';

/* ============================ Bayar (F4) ================================== */

export function DialogBayar({
  total,
  items,
  diskon,
  pajakPersen,
  gudangId,
  namaUsaha,
  alamatUsaha = null,
  teleponUsaha = null,
  logoUrl = null,
  modePos = 'foto',
  onSukses,
  onTutup,
}: {
  total: number;
  items: BarisKeranjang[];
  diskon: number;
  pajakPersen: number;
  gudangId: number;
  namaUsaha: string;
  /** Identitas toko untuk kop/kepala struk (BAGIAN J3). */
  alamatUsaha?: string | null;
  teleponUsaha?: string | null;
  logoUrl?: string | null;
  /** Tercatat di kolom sales.mode_pos: 'foto' (bawaan) atau 'cepat'. */
  modePos?: 'foto' | 'cepat';
  onSukses: (struk: StrukData) => void;
  onTutup: () => void;
}) {
  const [tunai, setTunai] = useState('');
  const [transfer, setTransfer] = useState('');
  const [qris, setQris] = useState('');
  const [kredit, setKredit] = useState('');
  const [pelangganId, setPelangganId] = useState('');
  const [pelangganOpsi, setPelangganOpsi] = useState<Opsi[]>([]);
  const [sibuk, setSibuk] = useState(false);

  const angka = (s: string) => Math.max(0, Number(s) || 0);
  const tunaiN = angka(tunai);
  const nonTunai = angka(transfer) + angka(qris) + angka(kredit);
  const sisaTunai = Math.max(0, total - nonTunai);
  const kurang = total - (tunaiN + nonTunai);
  const kembalian = Math.max(0, tunaiN - sisaTunai);
  const kreditN = angka(kredit);

  // Pelanggan hanya wajib saat bayar kredit/piutang.
  useEffect(() => {
    if (kreditN > 0 && pelangganOpsi.length === 0) {
      ambilOpsi('pelanggan')
        .then(setPelangganOpsi)
        .catch((e: Error) => beritahu(e.message, 'galat'));
    }
  }, [kreditN, pelangganOpsi.length]);

  const bayarCepat = useMemo(() => {
    const bulat = (n: number, kelipatan: number) => (n <= 0 ? 0 : Math.ceil(n / kelipatan) * kelipatan);
    const opsi = [sisaTunai, bulat(sisaTunai, 50_000), bulat(sisaTunai, 100_000)];
    return [...new Set(opsi)].filter((n) => n > 0);
  }, [sisaTunai]);

  const siapBayar = kurang < 0.5 && (kreditN <= 0 || pelangganId !== '');

  const bayar = async () => {
    if (!siapBayar || sibuk) return;
    setSibuk(true);
    try {
      const pembayaran = [
        { metode: 'tunai', jumlah: tunaiN },
        { metode: 'transfer', jumlah: angka(transfer) },
        { metode: 'qris', jumlah: angka(qris) },
        { metode: 'kredit', jumlah: kreditN },
      ].filter((p) => p.jumlah > 0);
      const r = await apiPost<{
        id: number;
        no_dokumen: string;
        kembalian: number;
        faktur?: { id: number; no_faktur: string } | null;
      }>('/api/pos/sales', {
        warehouse_id: gudangId,
        customer_id: pelangganId ? Number(pelangganId) : null,
        items: items.map((b) => ({ product_id: b.productId, qty: b.qty, harga: b.harga, diskon: b.diskon ?? 0 })),
        diskon,
        pajak_persen: pajakPersen,
        mode_pos: modePos,
        payments: pembayaran,
        // Waktu transaksi dari jam kasir (live clock header POS) — server
        // memvalidasi & memakai sebagai tanggal bila masuk akal.
        created_at: new Date().toISOString(),
      });
      const subtotal = items.reduce((a, b) => a + b.qty * b.harga, 0);
      // Total diskon struk = diskon kasir + Σ diskon baris (sama dengan server).
      const diskonTotal = diskon + items.reduce((a, b) => a + (b.diskon ?? 0), 0);
      const dasar = Math.max(0, subtotal - diskonTotal);
      const pajak = Math.round((dasar * pajakPersen) / 100);
      onSukses({
        namaUsaha,
        alamatUsaha,
        teleponUsaha,
        logoUrl,
        noDokumen: r.no_dokumen,
        tanggal: formatTanggalWaktu(new Date()),
        kasir: 'Admin',
        pelanggan: pelangganOpsi.find((o) => o.id === Number(pelangganId))?.label ?? null,
        items: items.map((b) => ({
          nama: b.nama,
          kode: b.sku,
          qty: b.qty,
          harga: b.harga,
          jumlah: b.qty * b.harga,
        })),
        subtotal,
        diskon: diskonTotal,
        pajak,
        total,
        bayar: pembayaran,
        kembalian: r.kembalian,
        fakturId: r.faktur?.id ?? null,
        noFaktur: r.faktur?.no_faktur ?? null,
      });
    } catch (e) {
      beritahu((e as Error).message, 'galat');
    } finally {
      setSibuk(false);
    }
  };

  // Keyboard penuh: Enter = Bayar & Simpan (tombol yang sedang difokus tidak
  // ikut agar tidak dobel — klik native pada tombol sudah menangani Enter).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || sibuk) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'BUTTON' || t.closest('button'))) return;
      e.preventDefault();
      void bayar();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <Modal
      judul="Pembayaran"
      lebar="sedang"
      onTutup={onTutup}
      sedangKirim={sibuk}
      aksi={
        <>
          <button type="button" className="tombol" onClick={onTutup} disabled={sibuk}>
            Batal (Esc)
          </button>
          <button type="button" className="tombol tombol--primer" onClick={bayar} disabled={!siapBayar || sibuk}>
            {sibuk ? 'Menyimpan…' : `Bayar & Simpan${kurang >= 0.5 ? ` (kurang ${formatRupiah(kurang)})` : ''}`}
          </button>
        </>
      }
    >
      <div className="pos-dialog">
        <div className="pos-struk-ringkas">
          <div className="r">
            <span>Total tagihan</span>
            <b>{formatRupiah(total)}</b>
          </div>
        </div>

        <label htmlFor="pos-tunai">Tunai</label>
        <input
          id="pos-tunai"
          inputMode="numeric"
          autoFocus
          placeholder="0"
          value={tunai}
          onChange={(e) => setTunai(e.target.value.replace(/\D/g, ''))}
        />
        <div className="pos-fastcash" role="group" aria-label="Nominal cepat">
          <button type="button" onClick={() => setTunai(String(sisaTunai))} title="Uang pas sebesar sisa tagihan">
            PAS
          </button>
          {[10_000, 20_000, 50_000, 100_000].map((n) => (
            <button key={n} type="button" onClick={() => setTunai(String(n))}>
              {n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)}
            </button>
          ))}
        </div>
        <div className="pos-bayar-cepat">
          {bayarCepat.map((n) => (
            <button key={n} type="button" onClick={() => setTunai(String(n))}>
              {n === sisaTunai ? 'Uang pas' : formatRupiah(n)}
            </button>
          ))}
          <button type="button" onClick={() => setTunai('')}>
            Kosongkan
          </button>
        </div>

        <div className="baris" style={{ marginTop: 10 }}>
          <div>
            <label htmlFor="pos-transfer">Transfer</label>
            <input id="pos-transfer" inputMode="numeric" placeholder="0" value={transfer} onChange={(e) => setTransfer(e.target.value.replace(/\D/g, ''))} />
          </div>
          <div>
            <label htmlFor="pos-qris">QRIS</label>
            <input id="pos-qris" inputMode="numeric" placeholder="0" value={qris} onChange={(e) => setQris(e.target.value.replace(/\D/g, ''))} />
          </div>
        </div>

        <label htmlFor="pos-kredit">Kredit / Piutang</label>
        <input id="pos-kredit" inputMode="numeric" placeholder="0" value={kredit} onChange={(e) => setKredit(e.target.value.replace(/\D/g, ''))} />
        {kreditN > 0 && (
          <>
            <label htmlFor="pos-pelanggan">Pelanggan (wajib untuk kredit)</label>
            <select id="pos-pelanggan" value={pelangganId} onChange={(e) => setPelangganId(e.target.value)}>
              <option value="">— Pilih pelanggan —</option>
              {pelangganOpsi.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            {pelangganOpsi.length === 0 && (
              <p className="pos-catatan-kecil">Belum ada pelanggan — buat dulu di Master › Pelanggan.</p>
            )}
          </>
        )}

        <div className="pos-kembalian">
          <span>{kurang >= 0.5 ? 'Kurang' : 'Kembalian'}</span>
          <b className={kurang >= 0.5 ? 'kurang' : 'cukup'}>{formatRupiah(kurang >= 0.5 ? kurang : kembalian)}</b>
        </div>
      </div>
    </Modal>
  );
}

/* ============================ Tahan transaksi (F8) ======================== */

export function DialogTahan({ onSimpan, onTutup }: { onSimpan: (nama: string) => Promise<void>; onTutup: () => void }) {
  const [nama, setNama] = useState('');
  const [sibuk, setSibuk] = useState(false);
  return (
    <Modal
      judul="Tahan Transaksi (F8)"
      lebar="kecil"
      onTutup={onTutup}
      sedangKirim={sibuk}
      aksi={
        <>
          <button type="button" className="tombol" onClick={onTutup} disabled={sibuk}>
            Batal
          </button>
          <button
            type="button"
            className="tombol tombol--primer"
            disabled={sibuk}
            onClick={async () => {
              setSibuk(true);
              try {
                await onSimpan(nama);
              } finally {
                setSibuk(false);
              }
            }}
          >
            {sibuk ? 'Menahan…' : 'Tahan'}
          </button>
        </>
      }
    >
      <div className="pos-dialog">
        <label htmlFor="pos-nama-tahan">Nama / catatan transaksi tertahan (opsional)</label>
        <input id="pos-nama-tahan" autoFocus placeholder="Contoh: Bayi beli 3 dus, bayar nanti" value={nama} onChange={(e) => setNama(e.target.value)} />
        <p className="pos-catatan-kecil">Keranjang dikosongkan; lanjutkan nanti dengan F9.</p>
      </div>
    </Modal>
  );
}

export interface BarisTertahan {
  id: number;
  dibuat_pada: string;
  data: { nama?: string; items: BarisKeranjang[]; diskon?: number; pajak_persen?: number; gudangId?: number } | null;
}

export function DialogTertahan({ onLanjut, onTutup }: { onLanjut: (b: BarisTertahan) => Promise<void>; onTutup: () => void }) {
  const [daftar, setDaftar] = useState<BarisTertahan[] | null>(null);
  const muat = () =>
    apiGet<{ data: BarisTertahan[] }>('/api/pos/held')
      .then((r) => setDaftar(r.data))
      .catch((e: Error) => beritahu(e.message, 'galat'));
  useEffect(() => {
    void muat();
  }, []);

  return (
    <Modal judul="Transaksi Tertahan (F9)" lebar="sedang" onTutup={onTutup}>
      <div className="pos-dialog">
        {daftar === null && <p className="teks-redup">Memuat…</p>}
        {daftar?.length === 0 && <p className="teks-redup">Belum ada transaksi tertahan. Tahan dengan F8.</p>}
        {daftar && daftar.length > 0 && (
          <table className="pos-tabel-mini">
            <thead>
              <tr>
                <th>Waktu</th>
                <th>Nama</th>
                <th className="num">Item</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {daftar.map((b) => (
                <tr key={b.id}>
                  <td>{formatTanggalWaktu(b.dibuat_pada)}</td>
                  <td>{b.data?.nama || '—'}</td>
                  <td className="num">{b.data?.items?.length ?? 0}</td>
                  <td>
                    <button type="button" onClick={() => void onLanjut(b)}>
                      Lanjutkan
                    </button>
                    <button
                      type="button"
                      className="bahaya"
                      onClick={() => {
                        apiDelete(`/api/pos/held/${b.id}`)
                          .then(muat)
                          .catch((e: Error) => beritahu(e.message, 'galat'));
                      }}
                    >
                      Hapus
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Modal>
  );
}

/* ============================ Shift kasir ================================= */

export function DialogShiftBuka({ onSukses, onTutup }: { onSukses: (s: ShiftAktif) => void; onTutup: () => void }) {
  const [kasAwal, setKasAwal] = useState('');
  const [sibuk, setSibuk] = useState(false);
  const buka = async () => {
    setSibuk(true);
    try {
      const r = await apiPost<{ id: number; data: ShiftAktif }>('/api/pos/shift/buka', { kas_awal: Number(kasAwal) || 0 });
      onSukses(r.data);
    } catch (e) {
      beritahu((e as Error).message, 'galat');
    } finally {
      setSibuk(false);
    }
  };
  return (
    <Modal
      judul="Buka Kasir"
      lebar="kecil"
      onTutup={onTutup}
      sedangKirim={sibuk}
      aksi={
        <>
          <button type="button" className="tombol" onClick={onTutup} disabled={sibuk}>
            Batal
          </button>
          <button type="button" className="tombol tombol--primer" onClick={buka} disabled={sibuk}>
            {sibuk ? 'Membuka…' : 'Buka Shift'}
          </button>
        </>
      }
    >
      <div className="pos-dialog">
        <label htmlFor="pos-kas-awal">Kas awal (jumlah uang di laci saat buka)</label>
        <input id="pos-kas-awal" autoFocus inputMode="numeric" placeholder="0" value={kasAwal} onChange={(e) => setKasAwal(e.target.value.replace(/\D/g, ''))} />
        <p className="pos-catatan-kecil">Penjualan baru bisa dilakukan setelah shift dibuka.</p>
      </div>
    </Modal>
  );
}

export function DialogShiftTutup({ shift, onSukses, onTutup }: { shift: ShiftAktif; onSukses: () => void; onTutup: () => void }) {
  const [fisik, setFisik] = useState('');
  const [sibuk, setSibuk] = useState(false);
  const [hasil, setHasil] = useState<{ kas_akhir_sistem: number; kas_akhir_fisik: number; selisih: number } | null>(null);

  const tutup = async () => {
    setSibuk(true);
    try {
      const r = await apiPost<{ kas_akhir_sistem: number; kas_akhir_fisik: number; selisih: number }>('/api/pos/shift/tutup', {
        kas_akhir_fisik: Number(fisik) || 0,
      });
      setHasil(r);
    } catch (e) {
      beritahu((e as Error).message, 'galat');
    } finally {
      setSibuk(false);
    }
  };

  return (
    <Modal
      judul="Tutup Kasir"
      lebar="kecil"
      onTutup={onTutup}
      sedangKirim={sibuk}
      aksi={
        hasil ? (
          <button
            type="button"
            className="tombol tombol--primer"
            onClick={() => {
              onSukses();
              onTutup();
            }}
          >
            Selesai
          </button>
        ) : (
          <>
            <button type="button" className="tombol" onClick={onTutup} disabled={sibuk}>
              Batal
            </button>
            <button type="button" className="tombol tombol--primer" onClick={tutup} disabled={sibuk}>
              {sibuk ? 'Menutup…' : 'Hitung & Tutup'}
            </button>
          </>
        )
      }
    >
      <div className="pos-dialog">
        <div className="pos-hasil-tutup">
          <div className="r">
            <span>Kas awal</span>
            <b>{formatRupiah(shift.kas_awal)}</b>
          </div>
          <div className="r">
            <span>Penjualan (disahkan)</span>
            <b>{formatRupiah(shift.ringkasan.penjualan)}</b>
          </div>
          <div className="r">
            <span>Uang tunai masuk</span>
            <b>{formatRupiah(shift.ringkasan.tunai)}</b>
          </div>
        </div>

        {!hasil ? (
          <>
            <label htmlFor="pos-kas-fisik">Hitungan kas fisik di laci</label>
            <input id="pos-kas-fisik" autoFocus inputMode="numeric" placeholder="0" value={fisik} onChange={(e) => setFisik(e.target.value.replace(/\D/g, ''))} />
            <p className="pos-catatan-kecil">Selisih = kas fisik − (kas awal + tunai masuk).</p>
          </>
        ) : (
          <div className="pos-hasil-tutup">
            <div className="r">
              <span>Kas sistem</span>
              <b>{formatRupiah(hasil.kas_akhir_sistem)}</b>
            </div>
            <div className="r">
              <span>Kas fisik</span>
              <b>{formatRupiah(hasil.kas_akhir_fisik)}</b>
            </div>
            <div className="r">
              <span>Selisih</span>
              <b className={hasil.selisih < 0 ? 'selisih-minus' : hasil.selisih > 0 ? 'selisih-plus' : ''}>
                {formatRupiah(hasil.selisih)}
                {hasil.selisih < 0 ? ' (kurang)' : hasil.selisih > 0 ? ' (lebih)' : ''}
              </b>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ================== Riwayat: void & retur (Admin + sandi) ================ */export interface BarisRiwayat {
  id: number;
  no_dokumen: string;
  tanggal: string;
  total: number;
  status: string;
  pelanggan: string | null;
  kasir: string | null;
  metode: string | null;
  /** Faktur penjualan terbit (R2 — kolom Dokumen di Riwayat & Dokumen). */
  faktur_id?: number | null;
  no_faktur?: string | null;
}

export interface DetailJual {
  id: number;
  no_dokumen: string;
  tanggal: string;
  subtotal: number;
  diskon: number;
  pajak: number;
  total: number;
  status: string;
  pelanggan: string | null;
  kasir: string | null;
  items: { product_id: number; qty: number; harga: number; subtotal: number; sku: string; nama_produk: string }[];
  payments: { metode: string; jumlah: number; referensi: string | null }[];
  /** Retur yang pernah dibuat untuk penjualan ini (bila ada). */
  retur?: { id: number; no_dokumen: string; tanggal: string; total: number; status: string }[];
}

/**
 * Bangun data struk dari penjualan tersimpan — dipakai DialogLayanan (POS)
 * dan halaman Riwayat Penjualan (aksi cetak ulang/kirim).
 */
export async function strukDariSale(saleId: number, namaUsaha: string): Promise<StrukData> {
  const r = await apiGet<{ data: DetailJual }>(`/api/pos/sales/${saleId}`);
  const d = r.data;
  return {
    namaUsaha,
    noDokumen: d.no_dokumen,
    tanggal: formatTanggalWaktu(d.tanggal),
    kasir: d.kasir ?? 'Admin',
    pelanggan: d.pelanggan,
    items: d.items.map((i) => ({ nama: i.nama_produk, kode: i.sku, qty: i.qty, harga: i.harga, jumlah: i.subtotal })),
    subtotal: Number(d.subtotal),
    diskon: Number(d.diskon),
    pajak: Number(d.pajak),
    total: Number(d.total),
    bayar: d.payments.map((x) => ({ metode: x.metode, jumlah: Number(x.jumlah) })),
    kembalian: 0,
  };
}

export function DialogLayanan({
  namaUsaha,
  profil,
  langkahAwal,
  onSelesai,
  onTutup,
}: {
  namaUsaha: string;

  /** Profil struk aktif (J3/J4) untuk cetak ulang dari riwayat. */
  profil?: ProfilStruk | null;
  /** M5 — buka langsung pada langkah void/retur tertentu (dari halaman Riwayat). */
  langkahAwal?: { mode: 'void' | 'retur'; sale: BarisRiwayat };
  /** Dipanggil setelah void/retur sukses bila dibuka dari luar POS (tutup + muat ulang). */
  onSelesai?: () => void;
  onTutup: () => void;
}) {
  const [daftar, setDaftar] = useState<BarisRiwayat[] | null>(null);
  const [langkah, setLangkah] = useState<{ mode: 'void' | 'retur'; sale: BarisRiwayat } | null>(null);
  const [waStruk, setWaStruk] = useState<StrukData | null>(null);
  const [detail, setDetail] = useState<DetailJual | null>(null);
  const [sandiAdmin, setSandiAdmin] = useState('');
  const admin = useSesi().info?.pengguna.admin ?? false;
  const [alasan, setAlasan] = useState('');
  const [qtyRetur, setQtyRetur] = useState<Record<number, number>>({});
  const [sibuk, setSibuk] = useState(false);

  const muat = () =>
    apiGet<{ data: BarisRiwayat[] }>('/api/pos/sales?per=50')
      .then((r) => setDaftar(r.data))
      .catch((e: Error) => beritahu(e.message, 'galat'));
  useEffect(() => {
    void muat();
  }, []);

  const bukaLangkah = async (mode: 'void' | 'retur', sale: BarisRiwayat) => {
    setLangkah({ mode, sale });
    setSandiAdmin('');
    setAlasan('');
    setQtyRetur({});
    setDetail(null);
    if (mode !== 'void') {
      try {
        const r = await apiGet<{ data: DetailJual }>(`/api/pos/sales/${sale.id}`);
        setDetail(r.data);
      } catch (e) {
        beritahu((e as Error).message, 'galat');
        setLangkah(null);
      }
    }
  };

  // M5 — dibuka dari halaman Riwayat Penjualan: langsung ke langkah yang diminta.
  const sudahAwal = useRef(false);
  useEffect(() => {
    if (sudahAwal.current || !langkahAwal) return;
    sudahAwal.current = true;
    void bukaLangkah(langkahAwal.mode, langkahAwal.sale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const kirim = async () => {
    if (!langkah) return;
    setSibuk(true);
    try {
      if (langkah.mode === 'void') {
        await apiPost(`/api/pos/sales/${langkah.sale.id}/void`, { sandi: sandiAdmin, alasan: alasan || 'Void POS' });
        beritahu(`Penjualan ${langkah.sale.no_dokumen} di-void; stok & jurnal dibatalkan.`, 'sukses');
      } else {
        const items = Object.entries(qtyRetur)
          .map(([productId, qty]) => ({ product_id: Number(productId), qty }))
          .filter((i) => i.qty > 0);
        if (items.length === 0) {
          beritahu('Tentukan qty retur minimal satu item.', 'galat');
          setSibuk(false);
          return;
        }
        const r = await apiPost<{ no_dokumen: string }>(`/api/pos/sales/${langkah.sale.id}/retur`, { sandi: sandiAdmin, alasan: alasan || null, items });
        beritahu(`Retur ${r.no_dokumen} dibuat; stok kembali & jurnal retur terbentuk.`, 'sukses');
      }
      setLangkah(null);
      setDetail(null);
      if (onSelesai) {
        // Dibuka dari halaman Riwayat: tutup dialog & muat ulang daftar.
        onSelesai();
      } else {
        await muat();
      }
    } catch (e) {
      beritahu((e as Error).message, 'galat');
    } finally {
      setSibuk(false);
    }
  };

  const p = profil ?? PROFIL_STRUK_BAWAAN;

  const strukDari = (sale: BarisRiwayat): Promise<StrukData> => strukDariSale(sale.id, namaUsaha);

  const cetakUlang = async (sale: BarisRiwayat) => {
    try {
      cetakStruk(await strukDari(sale), p);
    } catch (e) {
      beritahu((e as Error).message, 'galat');
    }
  };

  const pdfUlang = async (sale: BarisRiwayat) => {
    try {
      simpanStrukPdf(await strukDari(sale), p);
      beritahu('Pilih "Save as PDF" pada dialog cetak — nama file mengikuti nomor struk.', 'info', 4000);
    } catch (e) {
      beritahu((e as Error).message, 'galat');
    }
  };

  const kirimUlang = async (sale: BarisRiwayat) => {
    try {
      setWaStruk(await strukDari(sale));
    } catch (e) {
      beritahu((e as Error).message, 'galat');
    }
  };

  return (
    <Modal judul={langkah ? (langkah.mode === 'void' ? `Void ${langkah.sale.no_dokumen}` : `Retur ${langkah.sale.no_dokumen}`) : 'Riwayat & Layanan Penjualan'} lebar="lebar" onTutup={onTutup}>
      <div className="pos-dialog">
        {!langkah && daftar === null && <p className="teks-redup">Memuat…</p>}
        {!langkah && daftar?.length === 0 && <p className="teks-redup">Belum ada penjualan.</p>}
        {!langkah && daftar && daftar.length > 0 && (
          <table className="pos-tabel-mini">
            <thead>
              <tr>
                <th>No. Dokumen</th>
                <th>Waktu</th>
                <th>Pelanggan</th>
                <th className="num">Total</th>
                <th>Status</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {daftar.map((s) => (
                <tr key={s.id}>
                  <td>{s.no_dokumen}</td>
                  <td>{formatTanggalWaktu(s.tanggal)}</td>
                  <td>{s.pelanggan ?? 'Umum'}</td>
                  <td className="num">{formatRupiah(Number(s.total))}</td>
                  <td>{s.status}</td>
                  <td>
                    {s.status === 'disahkan' && admin && (
                      <>
                        <button type="button" className="bahaya" onClick={() => void bukaLangkah('void', s)}>
                          Void
                        </button>
                        <button type="button" onClick={() => void bukaLangkah('retur', s)}>
                          Retur
                        </button>
                      </>
                    )}
                    {/* J3: aksi struk — ikon saja (tooltip). */}
                    <IconButton label="Cetak struk" ikon="printer" ukuran="baris" onClick={() => void cetakUlang(s)} />
                    <IconButton label="Simpan struk (PDF)" ikon="download" ukuran="baris" onClick={() => void pdfUlang(s)} />
                    <IconButton label="Kirim struk (WhatsApp / Bagikan)" ikon="send" ukuran="baris" onClick={() => void kirimUlang(s)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {langkah && (
          <>
            <p className="pos-catatan-kecil">
              {langkah.mode === 'void'
                ? 'Void membatalkan penjualan: stok kembali, jurnal penjualan & HPP dibatalkan.'
                : 'Retur mengembalikan stok dan membentuk jurnal retur (debit penjualan, kredit kas + balik HPP).'}
            </p>

            {langkah.mode === 'retur' && (
              <table className="pos-tabel-mini">
                <thead>
                  <tr>
                    <th>Produk</th>
                    <th className="num">Terjual</th>
                    <th className="num">Harga</th>
                    <th className="num">Qty retur</th>
                  </tr>
                </thead>
                <tbody>
                  {(detail?.items ?? []).map((i) => (
                    <tr key={i.product_id}>
                      <td>{i.nama_produk}</td>
                      <td className="num">{i.qty}</td>
                      <td className="num">{formatRupiah(Number(i.harga))}</td>
                      <td className="num">
                        <input
                          style={{ width: 70, textAlign: 'right' }}
                          inputMode="numeric"
                          value={qtyRetur[i.product_id] ?? 0}
                          onChange={(e) => {
                            const v = Math.min(Number(i.qty), Math.max(0, Number(e.target.value.replace(/\D/g, '')) || 0));
                            setQtyRetur((q) => ({ ...q, [i.product_id]: v }));
                          }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <label htmlFor="pos-alasan">Alasan</label>
            <input id="pos-alasan" placeholder="Alasan (opsional)" value={alasan} onChange={(e) => setAlasan(e.target.value)} />

            <label htmlFor="pos-sandi-admin">Password login Admin (wajib)</label>
            <input
              id="pos-sandi-admin"
              type="password"
              autoComplete="current-password"
              autoFocus
              placeholder="Masukkan password Admin yang sedang login"
              value={sandiAdmin}
              onChange={(e) => setSandiAdmin(e.target.value)}
            />

            <div className="baris" style={{ marginTop: 12 }}>
              <button type="button" className="tombol" onClick={() => setLangkah(null)} disabled={sibuk}>
                Kembali
              </button>
              <button
                type="button"
                className="tombol tombol--primer"
                style={{ background: 'var(--danger-fill)', borderColor: 'var(--danger-fill)' }}
                onClick={kirim}
                disabled={sibuk || sandiAdmin.length === 0}
              >
                {sibuk ? 'Memproses…' : langkah.mode === 'void' ? 'Void Sekarang' : 'Buat Retur'}
              </button>
            </div>
          </>
        )}
      </div>
      {waStruk && (
        <DialogWa
          faktur={{
            id: 0,
            no_faktur: waStruk.noDokumen,
            tanggal: waStruk.tanggal,
            total: waStruk.total,
          }}
          pihakNama={waStruk.pelanggan ?? ''}
          pesanLain={pesanWaStruk(waStruk)}
          gambar={gambarStrukDok(waStruk, p)}
          onTutup={() => setWaStruk(null)}
        />
      )}
    </Modal>
  );
}

/* ============================ Hasil struk ================================= */

/**
 * Dialog sukses transaksi (BAGIAN J3): pratinjau struk sesuai profil aktif +
 * aksi ikon (Simpan PDF, Cetak, Kirim, Transaksi Baru) dengan tooltip.
 * Pintasan: Enter = Cetak, N = Transaksi Baru, Esc = tutup.
 */
export function DialogStruk({
  struk,
  profil,
  cetakOtomatis = false,
  onBaru,
  onTutup,
}: {
  struk: StrukData;
  profil?: ProfilStruk | null;
  /** Opsi "Cetak otomatis setelah bayar" (Pengaturan › Struk). */
  cetakOtomatis?: boolean;
  onBaru?: () => void;
  onTutup: () => void;
}) {
  const [dlgWa, setDlgWa] = useState(false);
  const navigasi = useNavigate();
  const wadahBaruRef = useRef<HTMLSpanElement>(null);
  const p = profil ?? PROFIL_STRUK_BAWAAN;
  const tautan = struk.fakturId ? `${window.location.origin}/penjualan/dokumen/${struk.fakturId}` : '';
  const suai = { width: '100%', border: '0', background: '#fff' };

  const cetak = () => {
    try {
      cetakStruk(struk, p);
    } catch (e) {
      beritahu((e as Error).message, 'galat');
    }
  };
  const simpanPdf = () => {
    try {
      simpanStrukPdf(struk, p);
      beritahu('Pilih "Save as PDF" pada dialog cetak — nama file mengikuti nomor struk.', 'info', 4000);
    } catch (e) {
      beritahu((e as Error).message, 'galat');
    }
  };

  // Web Share API (perangkat yang mendukung) — bagikan GAMBAR struk + teks.
  const bisaBagikan = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const [sibukBagikan, setSibukBagikan] = useState(false);
  const bagikan = () => {
    if (sibukBagikan) return;
    setSibukBagikan(true);
    void (async () => {
      try {          const dok = gambarStrukDok(struk, p);
          const png = await dokKePng(dok.model, dok.lebarPx);
        if (bisaBagikanGambar()) {
          const hasil = await bagikanGambar(png, dok.namaBerkas, `Struk ${struk.noDokumen}`, pesanWaStruk(struk));
          if (hasil === 'dibagikan') beritahu('Gambar struk dibagikan.', 'sukses');
          return;
        }
        void navigator
          .share({ title: `Struk ${struk.noDokumen}`, text: pesanWaStruk(struk), url: tautan || undefined })
          .catch(() => undefined); // pengguna membatalkan — abaikan
      } catch (e) {
        beritahu(e instanceof Error ? e.message : 'Gagal membagikan gambar struk.', 'galat');
      } finally {
        setSibukBagikan(false);
      }
    })();
  };

  // Cetak otomatis setelah bayar (sekali saat dialog dibuka).
  useEffect(() => {
    if (!cetakOtomatis) return;
    const t = window.setTimeout(() => {
      try {
        cetakStruk(struk, p);
      } catch {
        /* popup diblokir — biarkan pengguna mencetak manual */
      }
    }, 250);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pintasan dialog: Enter = Cetak, N = Transaksi Baru.
  useEffect(() => {
    // Tombol "Transaksi Baru" (ikon plus) mendapat fokus otomatis.
    wadahBaruRef.current?.querySelector('button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        cetak();
        return;
      }
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        if (onBaru) onBaru();
        else onTutup();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <Modal
      judul="Transaksi Berhasil"
      lebar="sedang"
      onTutup={onTutup}
      aksi={
        <>
          <button type="button" className="tombol" onClick={onTutup}>
            Tutup (Esc)
          </button>
        </>
      }
    >
      <div className="pos-dialog">
        {/* Pratinjau struk sesuai profil aktif (BAGIAN J4) */}
        <div className="pos-struk-pratinjau">
          <iframe
            title="Pratinjau struk"
            srcDoc={pratinjauStruk(struk, p)}
            style={{ ...suai, height: 360 }}
            aria-label="Pratinjau struk"
          />
        </div>

        {/* Aksi ikon (tooltip) — J3 */}
        <div className="faktur-sukses">
          <span className="teks-redup teks-kecil">
            Struk {struk.noDokumen} · {p.nama ?? p.kertas}
          </span>
          <div className="aksi-baris">
            {/* J3: Transaksi Baru — ikon plus, fokus otomatis; pintasan N. */}
            <span ref={wadahBaruRef} className="ikon-transaksi-baru">
              <IconButton
                label="Transaksi Baru (N)"
                ikon="plus"
                warna="primer"
                ukuran="toolbar"
                onClick={() => (onBaru ? onBaru() : onTutup())}
              />
            </span>
            <IconButton label="Simpan (PDF)" ikon="download" onClick={simpanPdf} />
            <IconButton label="Cetak" ikon="printer" onClick={cetak} />
            <IconButton label="Kirim (WhatsApp / Bagikan)" ikon="send" onClick={() => setDlgWa(true)} />
            {bisaBagikan && <IconButton label="Bagikan (Web Share)" ikon="share" onClick={bagikan} />}
            {struk.fakturId ? (
              <IconButton
                label="Buka faktur"
                ikon="faktur"
                onClick={() => navigasi(`/penjualan/dokumen/${struk.fakturId}`)}
              />
            ) : null}
          </div>
        </div>
        <p className="pos-catatan-kecil">
          Enter = cetak · N = transaksi baru · Esc = tutup. Stok berkurang, kartu stok &amp; jurnal terbentuk otomatis.
        </p>

        {dlgWa && (
          <DialogWa
            faktur={{
              id: Number(struk.fakturId ?? 0),
              no_faktur: struk.noDokumen,
              tanggal: struk.tanggal,
              total: struk.total,
            }}
          pihakNama={struk.pelanggan ?? ''}
          pesanLain={pesanWaStruk(struk, tautan)}
          gambar={gambarStrukDok(struk, p)}
          onTutup={() => setDlgWa(false)}
          />
        )}
      </div>
    </Modal>
  );
}
