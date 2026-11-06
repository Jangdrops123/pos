import { useEffect, useRef, useState } from 'react';
import { apiGet } from '../lib/api';
import { beritahu } from './crud/Toast';
import { formatRupiah } from '../lib/format';
import { TombolScan } from './ScanKamera';

/** Satu baris hasil pencarian produk (dari GET /api/pembelian/produk-cari). */
export type HasilProduk = {
  product_id: number;
  sku: string;
  barcode: string | null;
  harga_beli: number;
  produk: string;
  kode_item: string | null;
  satuan_dasar_id: number | null;
  satuan_dasar: string | null;
  stok: number;
  harga_terakhir: number | null;
  konversi: { unit_id: number; nama: string; jumlah_per_satuan_dasar: number }[];
};

type PosisiCari = {
  supplier_id: string;
  gudang_id: string;
};

/** Teks dengan kata kunci pencarian di-highlight (mirip Kasir Tanpa Foto). */
function TeksCocok({ teks, kata }: { teks: string; kata: string[] }) {
  if (kata.length === 0 || !teks) return <>{teks}</>;
  const pola = new RegExp(`(${kata.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'ig');
  const potong = teks.split(pola);
  return (
    <>
      {potong.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>))}
    </>
  );
}

type Props = {
  posisi: PosisiCari;
  /** Kolom cari hanya aktif bila pemasok & gudang sudah dipilih. */
  aktif: boolean;
  /** Token naik = kolom cari di-fokus & dikosongkan (usai tiap item ditambahkan). */
  fokusToken: number;
  /** dariScanner=true: input berasal dari scan barcode (fokus tetap di kolom cari). */
  onPilih: (h: HasilProduk, dariScanner?: boolean) => void;
  /** Buka form cepat tambah produk (mis. saat barcode belum terdaftar). */
  onProdukBaru: (teksSaatIni: string) => void;
  /**
   * Panah Bawah dari kolom cari saat dropdown tertutup/tak punya hasil →
   * masuk ke daftar item (baris pertama). Dipedomani spesifikasi mode Biasa:
   * perpindahan antara kolom cari dan daftar item hanya dengan panah ↑/↓.
   */
  onTanggaBawah?: () => void;
};

/**
 * Kolom cari utama mode Biasa — autocomplete produk (kode item, nama, SKU,
 * barcode), multi-kata, debounce 200 ms, maksimal 10 hasil, tanpa foto.
 * Meniru perilaku Kasir Tanpa Foto: panah ↑/↓ memilih, Enter menambah,
 * Esc menutup, Tab memilih lalu berpindah, dan barcode scanner (input persis
 * sama dengan barcode) langsung ditambahkan tanpa membuka dropdown.
 */
export function CariBarang({ posisi, aktif, fokusToken, onPilih, onProdukBaru, onTanggaBawah }: Props) {
  const [teks, setTeks] = useState('');
  const [hasil, setHasil] = useState<HasilProduk[]>([]);
  const [terbuka, setTerbuka] = useState(false);
  const [sorot, setSorot] = useState(0);
  const [sibuk, setSibuk] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const tokenRef = useRef(fokusToken);
  tokenRef.current = fokusToken;

  const kata = teks.trim() ? teks.trim().toLowerCase().split(/\s+/) : [];
  const url = (q: string) =>
    `/api/pembelian/produk-cari?cari=${encodeURIComponent(q)}&supplier_id=${encodeURIComponent(posisi.supplier_id)}&gudang_id=${encodeURIComponent(posisi.gudang_id)}`;

  /** Tambah produk. Jalur scanner mempertahankan fokus di kolom cari (scan
   *  beruntun); jalur dropdown menyerahkan fokus ke pemanggil (kolom Jumlah). */
  const pilih = (h: HasilProduk, dariScanner = false) => {
    setTeks('');
    setHasil([]);
    setTerbuka(false);
    onPilih(h, dariScanner);
    if (dariScanner) inputRef.current?.focus();
  };

  // Fokus + kosongkan tiap token naik (usai item ditambahkan / ganti metode).
  useEffect(() => {
    if (fokusToken === 0) return;
    inputRef.current?.focus();
    setTeks('');
    setHasil([]);
    setTerbuka(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fokusToken]);

  // Auto-scroll dropdown: baris tersorot selalu terlihat saat navigasi ↑/↓
  // (pola sama seperti pos-saran di kasir & Item Masuk/Keluar).
  useEffect(() => {
    if (!terbuka) return;
    dropdownRef.current?.querySelector('.terpilih')?.scrollIntoView({ block: 'nearest' });
  }, [sorot, terbuka, hasil.length]);

  // Debounce 200 ms — pencarian server, maksimal 10 hasil.
  useEffect(() => {
    const q = teks.trim();
    if (!aktif || q.length < 1) {
      setHasil([]);
      setTerbuka(false);
      return;
    }
    const t = window.setTimeout(async () => {
      setSibuk(true);
      try {
        const r = await apiGet<{ data: HasilProduk[] }>(url(q));
        // Barcode scanner: input persis sama dengan 1 barcode → langsung tambah
        // tanpa membuka dropdown (Enter dari scanner menyusul, tak masalah).
        const persis = r.data.filter((h) => (h.barcode ?? '').toLowerCase() === q.toLowerCase());
        if (persis.length === 1) {
          pilih(persis[0], true);
          return;
        }
        setHasil(r.data);
        setSorot(0);
        setTerbuka(true);
      } catch (e) {
        beritahu((e as Error).message, 'galat');
      } finally {
        setSibuk(false);
      }
    }, 200);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teks, aktif, posisi.supplier_id, posisi.gudang_id]);

  /** Enter: barcode persis → hasil teratas (atau daftar produk baru bila nihil). */
  const konfirmasi = async () => {
    const q = teks.trim();
    if (!q) return;
    const persis = hasil.find((h) => (h.barcode ?? '').toLowerCase() === q.toLowerCase());
    if (persis) {
      pilih(persis);
      return;
    }
    if (sorot >= 0 && hasil[sorot]) {
      pilih(hasil[sorot]);
      return;
    }
    // Scanner menekan Enter sebelum debounce sempat berjalan — ambil segar.
    try {
      const r = await apiGet<{ data: HasilProduk[] }>(url(q));
      const cocok = r.data.find((h) => (h.barcode ?? '').toLowerCase() === q.toLowerCase()) ?? (r.data.length === 1 ? r.data[0] : undefined);
      if (cocok) {
        pilih(cocok, true);
        return;
      }
    } catch {
      /* jatuh ke pesan di bawah */
    }
    onProdukBaru(q);
  };

  if (!aktif) {
    return (
      <div className="cari-barang cari-barang--nonaktif">
        <input
          className="cari-barang__input"
          placeholder="Cari / scan: kode item, nama, SKU, barcode... (F2)"
          disabled
          aria-label="Cari barang"
        />
        <p className="cari-barang__hint">Pilih pemasok &amp; gudang dulu</p>
      </div>
    );
  }

  return (
    <div className="cari-barang" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setTerbuka(false)}>
      <div className="cari-scan">
      <input
        ref={inputRef}
        id="search-item-input"
        className="cari-barang__input"
        value={teks}
        placeholder="Cari / scan: kode item, nama, SKU, barcode... (F2)"
        aria-label="Cari barang"
        autoComplete="off"
        role="combobox"
        aria-expanded={terbuka}
        aria-controls="cari-barang-hasil"
        onChange={(e) => {
          setTeks(e.target.value);
          setTerbuka(false);
        }}
        onFocus={() => hasil.length > 0 && setTerbuka(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (terbuka && hasil.length > 0) {
              setSorot((s) => Math.min(s + 1, hasil.length - 1));
              return;
            }
            // Dropdown tertutup → turun ke daftar item (baris pertama).
            onTanggaBawah?.();
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSorot((s) => Math.max(s - 1, 0));
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            if (terbuka && hasil.length > 0) {
              e.preventDefault();
              pilih(hasil[Math.min(sorot, hasil.length - 1)]);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              void konfirmasi();
            } else if (e.key === 'Tab' && teks.trim() === '') {
              // Kolom cari kosong + Tab → pindah ke baris pertama tabel item.
              e.preventDefault();
              onTanggaBawah?.();
            }
          } else if (e.key === 'Escape') {
            setTerbuka(false);
          }
        }}
      />
      <TombolScan onHasil={(t) => setTeks(t)} judul="Pindai barcode produk" />
      </div>
      {sibuk && <span className="cari-barang__status">Mencari…</span>}

      {terbuka && (
        <div className="cari-barang__dropdown" id="cari-barang-hasil" role="listbox" ref={dropdownRef}>
          {hasil.length === 0 ? (
            <div className="cari-barang__kosong">
              <span>Tidak ada produk cocok.</span>
              <button type="button" className="tombol tombol--kecil" onClick={() => onProdukBaru(teks)}>
                + Produk baru
              </button>
            </div>
          ) : (
            hasil.map((h, i) => (
              <div
                key={h.product_id}
                role="option"
                aria-selected={i === sorot}
                className={`cari-barang__baris ${i === sorot ? 'terpilih' : ''}`}
                onMouseEnter={() => setSorot(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pilih(h);
                }}
              >
                <div className="cari-barang__baris-utama">
                  <span className="cari-barang__kode">
                    <TeksCocok teks={h.kode_item ?? h.sku} kata={kata} />
                  </span>
                  <span className="cari-barang__nama">
                    <TeksCocok teks={h.produk} kata={kata} />
                  </span>
                  <span className="cari-barang__meta">
                    Stok: {h.stok} ·{' '}
                    {h.harga_terakhir !== null
                      ? `Harga beli terakhir: ${formatRupiah(h.harga_terakhir)}`
                      : `Harga beli master: ${formatRupiah(h.harga_beli)}`}
                  </span>
                </div>
              </div>
            ))
          )}
          {hasil.length > 0 && (
            <div className="cari-barang__kaki">
              <button type="button" className="tombol tombol--kecil" onClick={() => onProdukBaru(teks)}>
                + Produk baru
              </button>
              <span className="teks-redup teks-kecil">Enter: tambah · ↑↓: pilih · Esc: tutup</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
