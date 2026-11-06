import { Router } from 'express';
import { all, get, run, withTransaction } from '../db.pg.ts';
import { nomorOtomatis } from '../lib/pengaturanBaru.ts';
import { asyncHandler, bacaPaginasi, pesanKesalahan, polaCari, tolak } from '../lib/http.ts';
import { catatAudit } from '../lib/audit.ts';
import { penggunaSaatIni } from '../lib/akses.ts';
import { syaratGudangSesi, wajibGudangDiizinkan, wajibSel } from '../lib/hak.ts';
import { ubahStok } from '../lib/stok.ts';
import { uraiPembelianBaris } from '../lib/urai.ts';
import { catatCocok } from '../lib/cocok.ts';
import { buatFakturPembelian } from '../lib/faktur.ts';

/** AW3 — Kunci per dokumen mencegah klik ganda (gagal di tengah = tidak ada perubahan sebagian). */
const kunciDokumen = new Set<number>();
function kunciAmbil(id: number): boolean {
  if (kunciDokumen.has(id)) return false;
  kunciDokumen.add(id);
  return true;
}
function kunciLepas(id: number): void {
  kunciDokumen.delete(id);
}

/**
 * API Pembelian/Inbound — alur Purchase Order (opsional) → Penerimaan Barang
 * (GRN) → Faktur Pembelian dengan status: draft → diterima → disahkan.
 *
 * PENTING (sesuai spesifikasi): stok masuk + jurnal persediaan/hutang BARU
 * dibuat saat PENGESAHAN. Tahap GRN ('diterima') hanya mencatat penerimaan
 * (no. GRN + waktu) — tidak menggerakkan stok, tidak menulis jurnal.
 *
 * Tiga metode input (Biasa, Scan Barcode, Chatbot) memakai dokumen draft,
 * data, dan alur pengesahan YANG SAMA — hanya sisi input yang berbeda
 * (endpoint scan/chatbot menyusul pada prompt berikutnya).
 */

const METODE = new Set(['biasa', 'scan', 'chatbot']);
const STATUS_DIFORMAT = new Set(['draft', 'diterima', 'disahkan', 'batal']);

/** Nomor dokumen per bulan: PB-2026-10-0001, GRN-…, FP-…. */
async function nomorDokumen(prefix: string): Promise<string> {
  // Mengikuti Pengaturan ▸ Penomoran Dokumen; nilai bawaan = perilaku lama.
  const jenis = prefix === 'GRN' ? 'penerimaan' : prefix === 'FP' ? 'faktur_pemasok' : 'pembelian';
  return await nomorOtomatis(jenis);
}

/**
 * Lokasi penempatan stok masuk sebuah gudang.
 * Bila gudang belum punya lokasi, buatkan satu lokasi default otomatis
 * (`{KODE}-UTAMA`) agar pengesahan tidak gagal — dipanggil sekali per
 * dokumen (bukan per item), di dalam transaksi yang sama.
 */
async function lokasiGudang(warehouseId: number, userId: number | null): Promise<number> {
  const l = await get<{ id: number }>(`SELECT id FROM locations WHERE warehouse_id = ? ORDER BY id LIMIT 1`, warehouseId);
  if (l) return l.id;
  const g = await get<{ kode: string }>(`SELECT kode FROM warehouses WHERE id = ?`, warehouseId);
  const basis = `${String(g?.kode ?? `GD-${warehouseId}`).slice(0, 30)}-UTAMA`.toUpperCase();
  let kode = basis;
  let i = 2;
  while (await get<{ id: number }>(`SELECT id FROM locations WHERE kode_lokasi = ?`, kode)) {
    kode = `${basis}-${i}`;
    i += 1;
  }
  const r = await run(
    `INSERT INTO locations (warehouse_id, kode_lokasi, zona, dibuat_oleh) VALUES (?, ?, 'Utama', ?)`,
    warehouseId,
    kode,
    userId,
  );
  return Number(r.lastInsertRowid);
}

interface BarisMasuk {
  product_id: number;
  qty: number;
  unit_id: number | null;
  harga_beli: number;
  diskon: number;
  /** Dari box mana baris ini (metode Scan) — null = satuan/manual. */
  pack_id: number | null;
  /** Asal input: 'box' | 'satuan' | 'manual' (metode Scan). */
  sumber_scan: string | null;
}

const SUMBER_SCAN = new Set(['box', 'satuan', 'manual']);

interface LogScanMasuk {
  barcode: string;
  tipe: string;
  pack_id: number | null;
  product_id: number | null;
}

/** Validasi riwayat scan yang menyertai pembuatan draft (metode Scan). */
async function validasiLogScan(body: Record<string, unknown>): Promise<LogScanMasuk[]> {
  const raw = Array.isArray(body.scan_logs) ? (body.scan_logs as Record<string, unknown>[]) : [];
  return await Promise.all(raw.slice(0, 500).map(async (l) => {
    const barcode = String(l.barcode ?? '').trim();
    if (!barcode) throw tolak(400, 'Riwayat scan: barcode kosong.');
    if (barcode.length > 80) throw tolak(400, 'Riwayat scan: barcode maksimal 80 karakter.');
    const tipe = String(l.tipe ?? '');
    if (!['box', 'satuan', 'tidak_dikenal'].includes(tipe)) {
      throw tolak(400, 'Riwayat scan: tipe harus box/satuan/tidak_dikenal.');
    }
    const packId = l.pack_id ? Number(l.pack_id) : null;
    if (packId && !await get<{ id: number }>(`SELECT id FROM packs WHERE id = ?`, packId)) {
      throw tolak(400, 'Riwayat scan: paket tidak ditemukan.');
    }
    const productId = l.product_id ? Number(l.product_id) : null;
    if (productId && !await get<{ id: number }>(`SELECT id FROM products WHERE id = ?`, productId)) {
      throw tolak(400, 'Riwayat scan: produk tidak ditemukan.');
    }
    return { barcode, tipe, pack_id: packId, product_id: productId };
  }));
}

interface IsiPembelian {
  metode: string;
  supplier_id: number;
  warehouse_id: number;
  tanggal: string;
  no_po: string | null;
  pajak_persen: number;
  items: BarisMasuk[];
}

/** Validasi body buat/ubah draft — melempar 400/409 dengan pesan ramah. */
async function validasiIsi(body: Record<string, unknown>): Promise<IsiPembelian> {
  const supplier = Number(body.supplier_id);
  if (!Number.isInteger(supplier) || !await get<{ id: number }>(`SELECT id FROM suppliers WHERE id = ?`, supplier)) {
    throw tolak(400, 'Pemasok tidak ditemukan.');
  }
  const gudang = Number(body.warehouse_id);
  if (!Number.isInteger(gudang) || !await get<{ id: number }>(`SELECT id FROM warehouses WHERE id = ?`, gudang)) {
    throw tolak(400, 'Gudang tujuan tidak ditemukan.');
  }
  const metode = String(body.metode_input ?? 'biasa');
  if (!METODE.has(metode)) throw tolak(400, 'Metode input tidak dikenal (biasa/scan/chatbot).');

  let tanggal = new Date().toISOString();
  if (body.tanggal) {
    const d = new Date(String(body.tanggal));
    if (Number.isNaN(d.getTime())) throw tolak(400, 'Tanggal tidak valid.');
    tanggal = d.toISOString();
  }
  const no_po = String(body.no_po ?? '').trim() || null;
  const pajakPersen = Number(body.pajak_persen ?? 0);
  if (!Number.isFinite(pajakPersen) || pajakPersen < 0 || pajakPersen > 100) {
    throw tolak(400, 'Pajak harus antara 0–100%.');
  }

  const raw = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];
  if (raw.length === 0) throw tolak(400, 'Pembelian harus memiliki minimal satu item.');
  const lihat = new Set<string>();
  const items = await Promise.all(raw.map(async (i) => {
    const productId = Number(i.product_id);
    const v = await get<{ id: number; satuan_dasar_id: number | null }>(
      `SELECT id, satuan_dasar_id FROM products WHERE id = ?`,
      productId,
    );
    if (!v) throw tolak(400, 'Produk tidak ditemukan.');
    const qty = Number(i.qty);
    if (!Number.isFinite(qty) || qty <= 0) throw tolak(400, 'Jumlah harus lebih dari 0.');
    const harga = Number(i.harga_beli ?? 0);
    if (!Number.isFinite(harga) || harga < 0) throw tolak(400, 'Harga beli tidak valid.');
    const diskon = Number(i.diskon ?? 0);
    if (!Number.isFinite(diskon) || diskon < 0 || diskon > qty * harga + 1e-9) {
      throw tolak(400, 'Diskon item tidak boleh negatif atau melebihi nilai item.');
    }
    const unitId = i.unit_id ? Number(i.unit_id) : null;
    if (unitId && !await get<{ id: number }>(`SELECT id FROM units WHERE id = ?`, unitId)) {
      throw tolak(400, 'Satuan tidak ditemukan.');
    }
    if (unitId && v.satuan_dasar_id && unitId !== v.satuan_dasar_id) {
      const konversi = await get<{ id: number }>(
        `SELECT id FROM unit_conversions WHERE product_id = ? AND unit_id = ?`,
        productId,
        unitId,
      );
      if (!konversi) {
        throw tolak(400, 'Satuan terpilih belum dikonversi ke satuan dasar — lengkapi di Master › Konversi Satuan.');
      }
    }
    const packId = i.pack_id ? Number(i.pack_id) : null;
    if (packId && !await get<{ id: number }>(`SELECT id FROM packs WHERE id = ?`, packId)) {
      throw tolak(400, 'Paket/box tidak ditemukan.');
    }
    const sumberScan = i.sumber_scan ? String(i.sumber_scan) : null;
    if (sumberScan && !SUMBER_SCAN.has(sumberScan)) {
      throw tolak(400, 'Sumber scan tidak dikenal (box/satuan/manual).');
    }
    // Kecocokan unik per produk + paket: produk yang sama boleh muncul dua kali
    // bila satu baris dari box dan satu lagi satuan (indeks unik purchase_items).
    const kunci = `${productId}|${packId ?? -1}`;
    if (lihat.has(kunci)) throw tolak(409, 'Produk kembar dalam daftar item pembelian.');
    lihat.add(kunci);
    return { product_id: productId, qty, unit_id: unitId, harga_beli: harga, diskon, pack_id: packId, sumber_scan: sumberScan };
  }));

  return { metode, supplier_id: supplier, warehouse_id: gudang, tanggal, no_po, pajak_persen: pajakPersen, items };
}

/** Total dokumen: dasar = Σ(item) − diskon; pajak = round(dasar × %). */
function hitungTotal(items: BarisMasuk[], pajakPersen: number) {
  const subtotal = items.reduce((a, i) => a + i.qty * i.harga_beli, 0);
  const diskon = items.reduce((a, i) => a + i.diskon, 0);
  const dasar = subtotal - diskon;
  const pajak = Math.round((dasar * pajakPersen) / 100);
  return { subtotal, diskon, pajak, total: dasar + pajak };
}

const SELECT_PEMBELIAN = `
  SELECT p.*, s.nama AS pemasok, s.termin_hari, w.kode AS gudang_kode, w.nama AS gudang_nama,
         u.nama AS pembuat,
         (SELECT COUNT(*) FROM purchase_items i WHERE i.purchase_id = p.id) AS jumlah_item,
         (SELECT COALESCE(SUM(qty), 0) FROM purchase_items i WHERE i.purchase_id = p.id) AS jumlah_qty
  FROM purchases p
  JOIN suppliers s ON s.id = p.supplier_id
  JOIN warehouses w ON w.id = p.warehouse_id
  LEFT JOIN users u ON u.id = p.dibuat_oleh`;

async function bacaPembelian(id: number): Promise<Record<string, unknown>> {
  const p = await get<Record<string, unknown>>(`${SELECT_PEMBELIAN} WHERE p.id = ?`, id);
  if (!p) throw tolak(404, 'Dokumen pembelian tidak ditemukan.');
  const items = await all<Record<string, unknown>>(
    `SELECT i.*, i.sku, i.nama_produk AS produk, i.product_id, prod.satuan_dasar_id,
            un.nama AS satuan, un_dasar.nama AS satuan_dasar
     FROM purchase_items i
     JOIN products prod ON prod.id = i.product_id
     LEFT JOIN units un ON un.id = i.unit_id
     LEFT JOIN units un_dasar ON un_dasar.id = prod.satuan_dasar_id
     WHERE i.purchase_id = ?
     ORDER BY i.id`,
    id,
  );
  const jurnal =
    (await get<Record<string, unknown>>(
      `SELECT no_jurnal, tanggal, status FROM journals WHERE sumber_tipe = 'pembelian' AND sumber_id = ?`,
      id,
    )) ?? null;
  const hutang =
    (await get<Record<string, unknown>>(
      `SELECT id, jatuh_tempo, total, terbayar, status FROM payables WHERE purchase_id = ?`,
      id,
    )) ?? null;
  return { ...p, items, jurnal, hutang };
}

export function routerPembelian(): Router {
  const r = Router();

  // ==========================================================================
  // Daftar dokumen (semua metode input — draft & hasil pengesahan bersama)
  // ==========================================================================
  r.get('/', async (req, res) => {
    const p = bacaPaginasi(req, {
      urutBawaan: 'dibuat_pada',
      arahBawaan: 'DESC',
      urutDiizinkan: ['dibuat_pada', 'tanggal', 'total', 'no_dokumen'],
    });
    const syarat: string[] = [];
    const params: unknown[] = [];
    if (p.cari) {
      syarat.push(
        `(p.no_dokumen ILIKE ? ESCAPE '\\' OR p.no_grn ILIKE ? ESCAPE '\\' OR p.no_faktur ILIKE ? ESCAPE '\\'
          OR p.no_po ILIKE ? ESCAPE '\\' OR s.nama ILIKE ? ESCAPE '\\')`,
      );
      const pola = polaCari(p.cari);
      params.push(pola, pola, pola, pola, pola);
    }
    const status = String(req.query.status ?? '');
    if (STATUS_DIFORMAT.has(status)) {
      syarat.push('p.status = ?');
      params.push(status);
    }
    const metode = String(req.query.metode ?? '');
    if (METODE.has(metode)) {
      syarat.push('p.metode_input = ?');
      params.push(metode);
    }
    // R2 — filter periode tampil (Riwayat & Dokumen).
    const dari = String(req.query.dari ?? '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(dari)) {
      syarat.push('substr(p.tanggal, 1, 10) >= ?');
      params.push(dari);
    }
    const sampai = String(req.query.sampai ?? '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(sampai)) {
      syarat.push('substr(p.tanggal, 1, 10) <= ?');
      params.push(sampai);
    }
    // ISOLASI GUDANG — "Semua gudang" hanya mencakup gudang sesi; eksplisit
    // di luar cakupan ditolak 403 (pertahanan berlapis di samping middleware).
    if (req.query.gudang) {
      const gudangMinta = Number(req.query.gudang);
      await wajibGudangDiizinkan(req, gudangMinta);
      syarat.push('p.warehouse_id = ?');
      params.push(gudangMinta);
    } else {
      const lingkup = await syaratGudangSesi(req, 'p.warehouse_id');
      if (lingkup.sql) {
        syarat.push(lingkup.sql);
        params.push(...lingkup.params);
      }
    }
    const where = syarat.length ? `WHERE ${syarat.join(' AND ')}` : '';

    const total = Number(
      await ((await get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM purchases p JOIN suppliers s ON s.id = p.supplier_id ${where}`,
        ...params,
      )))?.n ?? 0,
    );
    const data = await all<Record<string, unknown>>(
      `${SELECT_PEMBELIAN} ${where} ORDER BY ${p.urut} ${p.arah}, p.id DESC LIMIT ? OFFSET ?`,
      ...params,
      p.per,
      p.offset,
    );
    res.json({ data, total, hal: p.hal, per: p.per });
  });

  // ==========================================================================
  // Mode Biasa: kolom cari (autocomplete) — satu endpoint yang mengembalikan
  // data lengkap per produk: kode item, SKU/barcode, stok di gudang tujuan,
  // harga beli terakhir dari pemasok tsb (fallback harga master), dan opsi
  // konversi satuan. Pencarian multi-kata, case-insensitive, dibatasi 10 baris
  // agar tetap ringan (klien men-cache daftar ini sekali per pemasok/gudang).
  // ==========================================================================
  r.get('/produk-cari', async (req, res) => {
    const cari = String(req.query.cari ?? '').trim();
    const supplierId = Number(req.query.supplier_id) || null;
    const gudangId = Number(req.query.gudang_id) || null;
    // ISOLASI GUDANG — angka stok autocomplete tanpa gudang hanya dari
    // gudang yang diizinkan sesi; filter eksplisit dicek 403 berlapis.
    if (gudangId) await wajibGudangDiizinkan(req, gudangId);
    const lingkupStok = gudangId ? { sql: '', params: [] as number[] } : await syaratGudangSesi(req, 'sb.warehouse_id');
    const batasStokPc = lingkupStok.sql === '1 = 0' ? 'AND 1 = 0' : lingkupStok.sql ? `AND ${lingkupStok.sql}` : '';
    // `ids` = daftar product_id dipisah koma (dipakai form Ubah untuk memperkaya
    // baris dokumen lama: konversi satuan & kode item) — tanpa kata kunci.
    const ids = String(req.query.ids ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, 100);
    const kata = cari ? cari.split(/\s+/).filter(Boolean) : [];
    const syarat = ['p.aktif = TRUE'];
    const params: unknown[] = [];
    // ISOLASI GUDANG MUTLAK — kandidat HANYA produk yang terdaftar (punya
    // baris saldo) di gudang tujuan, ala POS Tanpa Foto. Tanpa ini barang
    // GD-1 bisa dipilih pada draft pembelian GD-2 (dan sebaliknya).
    if (gudangId) {
      syarat.push('EXISTS (SELECT 1 FROM stock_balances sbG WHERE sbG.product_id = p.id AND sbG.warehouse_id = ?)');
      params.push(gudangId);
    }
    if (ids.length > 0) {
      syarat.push(`p.id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
    for (const k of kata) {
      syarat.push(
        `(COALESCE(p.kode_item, '') ILIKE ? ESCAPE '\\' OR p.nama ILIKE ? ESCAPE '\\'
           OR p.sku ILIKE ? ESCAPE '\\' OR COALESCE(p.barcode, '') ILIKE ? ESCAPE '\\')`,
      );
      const pola = polaCari(k);
      params.push(pola, pola, pola, pola);
    }
    const data = await (await all<Record<string, unknown>>(
      `SELECT p.id AS product_id, p.sku, p.barcode, p.harga_beli,
              p.nama AS produk, p.kode_item, p.satuan_dasar_id,
              un.nama AS satuan_dasar,
              (SELECT COALESCE(SUM(sb.qty), 0) FROM stock_balances sb
                WHERE sb.product_id = p.id ${gudangId ? 'AND sb.warehouse_id = ?' : batasStokPc}) AS stok,
              (SELECT pi.harga_beli FROM purchase_items pi
                 JOIN purchases pp ON pp.id = pi.purchase_id
                WHERE pi.product_id = p.id ${supplierId ? 'AND pp.supplier_id = ?' : ''}
                ORDER BY pp.tanggal DESC, pi.id DESC LIMIT 1) AS harga_terakhir,
              (SELECT STRING_AGG(un2.id || '|' || un2.nama || '=' || uc.jumlah_per_satuan_dasar, ',')
                 FROM unit_conversions uc JOIN units un2 ON un2.id = uc.unit_id
                WHERE uc.product_id = p.id) AS konversi
         FROM products p
         LEFT JOIN units un ON un.id = p.satuan_dasar_id
        WHERE ${syarat.join(' AND ')} AND p.deleted_at IS NULL
        ORDER BY p.nama, p.sku
        LIMIT ${ids.length ? 200 : 10}`,
      ...(gudangId ? [gudangId] : [...lingkupStok.params]),
      ...(supplierId ? [supplierId] : []),
      ...params,
    )).map((r) => ({
      ...r,
      konversi: r.konversi
        ? String(r.konversi)
            .split(',')
            .map((s) => {
              const [id, nama] = s.split('|');
              const jml = s.slice(s.lastIndexOf('=') + 1);
              return { unit_id: Number(id), nama, jumlah_per_satuan_dasar: Number(jml) };
            })
        : [],
    }));
    res.json({ data });
  });

  r.get('/:id', async (req, res) => {
    const dok = await bacaPembelian(Number(req.params.id));
    await wajibGudangDiizinkan(req, Number(dok.warehouse_id));
    res.json({ data: dok });
  });

  // ==========================================================================
  // Chatbot (AG): urai teks multi-baris → pratinjau per size (parser aturan
  // lokal, tanpa API eksternal) — riwayat pesan disimpan per sesi, diklaim ke
  // dokumen saat draft dibuat (lihat POST '/' → chat_sesi). Setiap hasil
  // pencocokan dicatat di chat_match_logs (teks, hasil, skor, pengguna).
  // ==========================================================================
  r.post(
    '/chat/urai',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const teks = String(body.teks ?? '').trim();
      if (!teks) throw tolak(400, 'Teks chat kosong — ketik keterangan pembelian dulu.');
      if (teks.length > 4000) throw tolak(400, 'Teks chat terlalu panjang (maksimal 4000 karakter).');
      const chatSesi = String(body.chat_sesi ?? '').trim() || null;
      const purchaseId = body.purchase_id ? Number(body.purchase_id) : null;
      if (purchaseId && !await get<{ id: number }>(`SELECT id FROM purchases WHERE id = ?`, purchaseId)) {
        throw tolak(404, 'Dokumen pembelian tidak ditemukan.');
      }

      const pengguna = penggunaSaatIni(req);
      const hasil = await uraiPembelianBaris(teks);
      // AG3 — log pencocokan: pemasok + tiap baris (teks, hasil, skor, pengguna).
      if (hasil.pemasok.teks) {
        await catatCocok({
          tipe: 'pemasok',
          teks: hasil.pemasok.teks,
          hasil: hasil.pemasok.cocok ? 'yakin' : hasil.pemasok.saran.length ? 'kabur' : 'tidak',
          skor: hasil.pemasok.skor,
          supplier_id: hasil.pemasok.supplier_id,
          pengguna_id: pengguna.id,
        });
      }
      for (const p of hasil.pratinjau ?? []) {
        await catatCocok({
          tipe: 'produk',
          teks: p.teks,
          hasil: p.kecocokan,
          skor: p.skor,
          product_id: p.rincian.map((x) => x.product_id).find((x) => x) ?? null,
          pengguna_id: pengguna.id,
          detail: { profil: p.profil_kode, db: p.db, tp: p.tp, total_pasang: p.total_pasang },
        });
      }
      const logId = Number(
        await ((await run(
          `INSERT INTO purchase_chat_logs (purchase_id, chat_sesi, pesan_user, pesan_bot, hasil_parse_json)
           VALUES (?, ?, ?, ?, ?)`,
          purchaseId,
          chatSesi,
          teks,
          hasil.pesan_bot,
          JSON.stringify({ pemasok: hasil.pemasok, baris: hasil.baris, catatan: hasil.catatan }),
        ))).lastInsertRowid,
      );
      res.status(201).json({ log_id: logId, ...hasil });
    }),
  );

  // AF4/AF5 — hitung ulang SATU baris pratinjau setelah pengguna mengganti
  // profil / Db / Tp. Tanpa penyimpanan riwayat (hanya pratinjau).
  r.post(
    '/chat/ulang',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const teks = String(body.teks ?? '').trim();
      if (!teks) throw tolak(400, 'Teks baris kosong.');
      if (teks.length > 1000) throw tolak(400, 'Teks baris terlalu panjang (maksimal 1000 karakter).');
      const ubah = (body.ubah ?? {}) as { profil_id?: number | null; db?: number | null; tp?: number | null };
      res.json(await uraiPembelianBaris(teks, ubah));
    }),
  );

  // Riwayat input per dokumen pembelian (untuk modal "Lihat"): percakapan chatbot
  // dan/atau log pemindaian barcode — bentuk keluaran seragam agar UI satu panel.
  r.get('/:id/chat', async (req, res) => {
    const id = Number(req.params.id);
    const dokChat = await get<{ id: number; warehouse_id: number }>(`SELECT id, warehouse_id FROM purchases WHERE id = ?`, id);
    if (!dokChat) {
      throw tolak(404, 'Dokumen pembelian tidak ditemukan.');
    }
    await wajibGudangDiizinkan(req, Number(dokChat.warehouse_id));
    const chat = await (await all<Record<string, unknown>>(
      `SELECT id, chat_sesi, pesan_user, pesan_bot, waktu
         FROM purchase_chat_logs
        WHERE purchase_id = ?
        ORDER BY id`,
      id,
    )).map((c) => ({ ...c, sumber: 'chat' }));
    const scan = await (await all<Record<string, unknown>>(
      `SELECT sl.id, sl.barcode, sl.tipe, sl.pack_id, sl.product_id, sl.waktu,
              pk.nama AS pack_nama, pr.sku
         FROM purchase_scan_logs sl
         LEFT JOIN packs pk ON pk.id = sl.pack_id
         LEFT JOIN products pr ON pr.id = sl.product_id
        WHERE sl.purchase_id = ?
        ORDER BY sl.id`,
      id,
    )).map((s) => ({
      id: Number(s.id),
      chat_sesi: null,
      pesan_user: `📷 ${String(s.barcode)}`,
      pesan_bot:
        s.tipe === 'box'
          ? `Box "${String(s.pack_nama ?? s.pack_id)}" — seluruh isi masuk draft.`
          : s.tipe === 'satuan'
            ? `Produk satuan: ${String(s.sku ?? s.product_id)} — 1 pcs.`
            : 'Barcode belum terdaftar (tidak masuk draft).',
      waktu: s.waktu,
      sumber: 'scan',
    }));
    const data = ([...chat, ...scan] as Record<string, unknown>[]).sort(
      (a, b) => String(a.waktu).localeCompare(String(b.waktu)) || Number(a.id) - Number(b.id),
    );
    res.json({ data });
  });

  // ==========================================================================
  // Scan Barcode (metode Scan): resolve barcode → paket/box ATAU produk
  // satuan, atau tidak dikenal (dialog pendaftaran di sisi klien).
  // ==========================================================================
  r.post(
    '/scan',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const barcode = String(body.barcode ?? '').trim();
      if (!barcode) throw tolak(400, 'Barcode kosong — pindai atau ketik barcode dulu.');
      if (barcode.length > 80) throw tolak(400, 'Barcode maksimal 80 karakter.');
      // ISOLASI GUDANG MUTLAK — hasil scan dikunci ke gudang tujuan draft:
      // barang yang tidak terdaftar di gudang itu ditolak dengan pesan tegas.
      const gudangId = Number(body.gudang_id ?? 0) || null;
      if (gudangId) await wajibGudangDiizinkan(req, gudangId);
      const namaGudang = gudangId
        ? (await ((await get<{ nama: string }>('SELECT nama FROM warehouses WHERE id = ?', gudangId)))?.nama ?? `Gudang #${gudangId}`)
        : null;
      const terdaftarDi = async (productId: number): Promise<boolean> =>
        !gudangId ||
        !!await get<{ product_id: number }>('SELECT product_id FROM stock_balances WHERE product_id = ? AND warehouse_id = ?', productId, gudangId);

      // 1) Paket/Box lebih dulu (barcode_box).
      const pack = await get<{ id: number; kode_box: string; nama: string; barcode_box: string }>(
        `SELECT id, kode_box, nama, barcode_box FROM packs WHERE barcode_box = ?`,
        barcode,
      );
      if (pack) {
        const items = await all<Record<string, unknown>>(
          `SELECT pi.product_id, pi.qty AS qty_per_box, pr.sku, pr.harga_beli, pr.satuan_dasar_id, pr.nama AS produk
             FROM pack_items pi
             JOIN products pr ON pr.id = pi.product_id
            WHERE pi.pack_id = ?
            ORDER BY pr.sku`,
          pack.id,
        );
        if (items.length === 0) {
          throw tolak(409, `Paket "${pack.nama}" tidak memiliki isi — lengkapi dulu di Master › Paket.`);
        }
        if (gudangId) {
          const asing: typeof items = [];
          for (const i of items) {
            if (!(await terdaftarDi(Number(i.product_id)))) asing.push(i);
          }
          if (asing.length > 0) {
            throw tolak(400, `Paket "${pack.nama}" tidak terdaftar di ${namaGudang} (${asing.length} isi di luar gudang ini).`);
          }
        }
        const totalPcs = items.reduce((n, i) => n + Number(i.qty_per_box), 0);
        res.json({ tipe: 'box', barcode, pack: { ...pack, total_pcs: totalPcs, items }, produk: null });
        return;
      }

      // 2) Produk satuan (barcode produk, case-insensitive).
      const pr = await get<Record<string, unknown>>(
        `SELECT id AS product_id, sku, barcode, harga_beli, satuan_dasar_id, nama AS produk
           FROM products
          WHERE barcode IS NOT NULL AND lower(barcode) = lower(?) AND deleted_at IS NULL`,
        barcode,
      );
      if (pr) {
        if (gudangId && !await terdaftarDi(Number(pr.product_id))) {
          throw tolak(400, `Barang ini tidak terdaftar di ${namaGudang}.`);
        }
        res.json({ tipe: 'satuan', barcode, produk: pr, pack: null });
        return;
      }

      // 3) Tidak dikenal — klien menampilkan dialog pendaftaran.
      res.json({ tipe: 'tidak_dikenal', barcode, pack: null, produk: null });
    }),
  );

  // ==========================================================================
  // Draft (PO opsional): buat / ubah / hapus — TIDAK menggerakkan stok
  // ==========================================================================
  r.post(
    '/',
    asyncHandler(async (req, res) => {
      const pengguna = penggunaSaatIni(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const isi = await validasiIsi(body);
      // ISOLASI GUDANG — draft tidak boleh dibuat ke gudang di luar cakupan.
      await wajibGudangDiizinkan(req, isi.warehouse_id);
      const t = hitungTotal(isi.items, isi.pajak_persen);
      const chatSesi = String(body.chat_sesi ?? '').trim() || null;
      const chatRincian = body.chat_rincian === undefined || body.chat_rincian === null ? null : JSON.stringify(body.chat_rincian).slice(0, 200000);
      const logsScan = await validasiLogScan(body);

      const idBaru = await withTransaction(async () => {
        const noDok = await nomorDokumen('PB');
        const id = Number(
          await ((await run(
            `INSERT INTO purchases (no_dokumen, no_po, tanggal, supplier_id, warehouse_id, metode_input,
                                    subtotal, diskon, pajak_persen, pajak, total, status, dibuat_oleh)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`,
            noDok,
            isi.no_po,
            isi.tanggal,
            isi.supplier_id,
            isi.warehouse_id,
            isi.metode,
            t.subtotal,
            t.diskon,
            isi.pajak_persen,
            t.pajak,
            t.total,
            pengguna.id,
          ))).lastInsertRowid,
        );
        // AG9 — rincian size, profil, dan komposisi Db/Tp ikut tersimpan pada dokumen.
        if (chatRincian) await run(`UPDATE purchases SET chat_rincian_json = ? WHERE id = ?`, chatRincian, id);
        for (const i of isi.items) await tulisItem(id, i);
        // Riwayat scan barcode untuk dokumen ini (metode Scan).
        for (const l of logsScan) {
          await run(
            `INSERT INTO purchase_scan_logs (purchase_id, barcode, tipe, pack_id, product_id, user_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            id,
            l.barcode,
            l.tipe,
            l.pack_id,
            l.product_id,
            pengguna.id,
          );
        }
        // Klaim riwayat chat sesi ini ke dokumen (pesan pra-dokumen).
        if (chatSesi) {
          await run(
            `UPDATE purchase_chat_logs SET purchase_id = ? WHERE chat_sesi = ? AND purchase_id IS NULL`,
            id,
            chatSesi,
          );
        }
        await catatAudit({
          userId: pengguna.id,
          aksi: 'tambah',
          tabel: 'purchases',
          recordId: id,
          sesudah: { no_dokumen: noDok, metode_input: isi.metode, supplier_id: isi.supplier_id, warehouse_id: isi.warehouse_id, items: isi.items.length, total: t.total },
        });
        return id;
      });

      res.status(201).json({ id: idBaru, data: await bacaPembelian(idBaru) });
    }),
  );

  r.put(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const pengguna = penggunaSaatIni(req);
      const lama = await get<Record<string, unknown>>(`SELECT * FROM purchases WHERE id = ?`, id);
      if (!lama) throw tolak(404, 'Dokumen pembelian tidak ditemukan.');
      // AX — matriks saja: Ubah draft butuh sel Ubah pada Pembelian.
      await wajibSel(req, 'pembelian', 'ubah');
      if (lama.status !== 'draft') {
        throw tolak(409, `Hanya draft yang bisa diubah — status saat ini "${lama.status}". Dokumen diterima/disahkan harus dibatalkan dulu.`);
      }
      const isi = await validasiIsi((req.body ?? {}) as Record<string, unknown>);
      await wajibGudangDiizinkan(req, isi.warehouse_id);
      const t = hitungTotal(isi.items, isi.pajak_persen);

      await withTransaction(async () => {
        await run(
          `UPDATE purchases SET no_po = ?, tanggal = ?, supplier_id = ?, warehouse_id = ?,
                  subtotal = ?, diskon = ?, pajak_persen = ?, pajak = ?, total = ?, diubah_pada = ?
           WHERE id = ?`,
          isi.no_po,
          isi.tanggal,
          isi.supplier_id,
          isi.warehouse_id,
          t.subtotal,
          t.diskon,
          isi.pajak_persen,
          t.pajak,
          t.total,
          new Date().toISOString(),
          id,
        );
        await run(`DELETE FROM purchase_items WHERE purchase_id = ?`, id);
        for (const i of isi.items) await tulisItem(id, i);
        await catatAudit({
          userId: pengguna.id,
          aksi: 'ubah',
          tabel: 'purchases',
          recordId: id,
          sebelum: { status: lama.status, no_po: lama.no_po, supplier_id: lama.supplier_id, warehouse_id: lama.warehouse_id, total: lama.total },
          sesudah: { status: 'draft', no_po: isi.no_po, supplier_id: isi.supplier_id, warehouse_id: isi.warehouse_id, total: t.total, items: isi.items.length },
        });
      });

      res.json({ ok: true, data: await bacaPembelian(id) });
    }),
  );

  r.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const pengguna = penggunaSaatIni(req);
      const lama = await get<Record<string, unknown>>(`SELECT * FROM purchases WHERE id = ?`, id);
      if (!lama) throw tolak(404, 'Dokumen pembelian tidak ditemukan.');
      // AX — hapus draft butuh sel Hapus pada Pembelian.
      await wajibSel(req, 'pembelian', 'hapus');
      if (lama.status !== 'draft') throw tolak(409, 'Hanya draft yang bisa dihapus.');
      await withTransaction(async () => {
        await run(`DELETE FROM purchases WHERE id = ?`, id);
        await catatAudit({ userId: pengguna.id, aksi: 'hapus', tabel: 'purchases', recordId: id, sebelum: lama });
      });
      res.json({ ok: true });
    }),
  );

  // ==========================================================================
  // GRN (Penerimaan Barang): draft → diterima. BELUM ada stok/jurnal.
  // ==========================================================================
  r.post(
    '/:id/terima',
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const pengguna = penggunaSaatIni(req);
      const body = (req.body ?? {}) as Record<string, unknown>;

      // AX2 — Terima barang (GRN) = sel Ubah pada Pembelian.
      // Kunci per dokumen mencegah klik ganda.
      if (!kunciAmbil(id)) throw tolak(409, 'Dokumen sedang diproses — tunggu sebentar lalu muat ulang.');
      try {
        // AX2 — Terima barang (GRN) = sel Ubah pada Pembelian.
        await wajibSel(req, 'pembelian', 'ubah');
        await withTransaction(async () => {
          const p = await get<Record<string, unknown>>(`SELECT * FROM purchases WHERE id = ?`, id);
          if (!p) throw tolak(404, 'Dokumen pembelian tidak ditemukan.');
          await wajibGudangDiizinkan(req, Number(p.warehouse_id));
          if (p.status === 'batal') throw tolak(409, 'Dokumen dibatalkan tidak bisa diterima. Alasan: status saat ini "batal".');
          if (p.status !== 'draft') throw tolak(409, `Hanya draft yang bisa diterima (GRN) — status saat ini "${p.status}".`);
          const jumlah = Number(
            await ((await get<{ n: number }>(`SELECT COUNT(*) AS n FROM purchase_items WHERE purchase_id = ?`, id)))?.n ?? 0,
          );
          if (jumlah === 0) throw tolak(400, 'Dokumen tanpa item — lengkapi item sebelum diterima.');
          const noGrn = String(body.no_grn ?? '').trim() || await nomorDokumen('GRN');
          if (await get<{ id: number }>(`SELECT id FROM purchases WHERE no_grn = ? AND id <> ?`, noGrn, id)) {
            throw tolak(409, `No. GRN "${noGrn}" sudah dipakai dokumen lain.`);
          }
          const sekarang = new Date().toISOString();
          await run(
            `UPDATE purchases SET status = 'diterima', no_grn = ?, diterima_pada = ?, diubah_pada = ? WHERE id = ?`,
            noGrn,
            sekarang,
            sekarang,
            id,
          );
          await catatAudit({
            userId: pengguna.id,
            aksi: 'terima',
            tabel: 'purchases',
            recordId: id,
            sebelum: { status: 'draft' },
            sesudah: { status: 'diterima', no_grn: noGrn },
          });
        });
      } finally {
        kunciLepas(id);
      }

      res.json({ ok: true, data: await bacaPembelian(id) });
    }),
  );

  // ==========================================================================
  // Pengesahan (Faktur): stok masuk + kartu stok + jurnal persediaan/utang
  // + baris hutang pemasok — semuanya dalam SATU transaksi.
  // ==========================================================================
  r.post(
    '/:id/sahkan',
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const pengguna = penggunaSaatIni(req);
      const body = (req.body ?? {}) as Record<string, unknown>;

      // AX2 — Sahkan faktur = sel Sahkan pada Pembelian.
      if (!kunciAmbil(id)) throw tolak(409, 'Dokumen sedang diproses — tunggu sebentar lalu muat ulang.');
      let faktur: { id: number; no_faktur: string } | null = null;
      try {
        // AX2 — Sahkan faktur (posting stok & hutang) = sel Sahkan pada Pembelian.
        await wajibSel(req, 'pembelian', 'sahkan');
        const noFakturMinta = String(body.no_faktur ?? '').trim() || null;
        let jatuhTempo: string | null = null;
        if (body.jatuh_tempo) {
          const d = new Date(String(body.jatuh_tempo));
          if (Number.isNaN(d.getTime())) throw tolak(400, 'Jatuh tempo tidak valid.');
          jatuhTempo = d.toISOString().slice(0, 10);
        }
        await withTransaction(async () => {
          const p = await get<Record<string, unknown>>(`SELECT * FROM purchases WHERE id = ?`, id);
          if (!p) throw tolak(404, 'Dokumen pembelian tidak ditemukan.');
          await wajibGudangDiizinkan(req, Number(p.warehouse_id));
          if (p.status === 'batal') throw tolak(409, 'Dokumen dibatalkan tidak bisa disahkan. Alasan: status saat ini "batal".');
          if (p.status !== 'diterima') {
            throw tolak(409, `Hanya dokumen berstatus diterima (GRN) yang bisa disahkan — status saat ini "${p.status}".`);
          }

        const items = await all<{ product_id: number; qty: number; unit_id: number | null; subtotal: number; location_id: number | null; satuan_dasar_id: number | null; sku: string; nama_produk: string }>(
          `SELECT i.product_id, i.qty, i.unit_id, i.subtotal, i.location_id, i.sku, i.nama_produk, prod.satuan_dasar_id
           FROM purchase_items i
           JOIN products prod ON prod.id = i.product_id
           WHERE i.purchase_id = ?
           ORDER BY i.id`,
          id,
        );
        if (items.length === 0) throw tolak(400, 'Dokumen tanpa item — tidak bisa disahkan.');

        const noFaktur = noFakturMinta || await nomorDokumen('FP');
        if (noFakturMinta && (await get<{ id: number }>(`SELECT id FROM purchases WHERE no_faktur = ? AND id <> ?`, noFakturMinta, id))) {
          throw tolak(409, `No. faktur "${noFakturMinta}" sudah dipakai dokumen lain.`);
        }

        // Sekali per dokumen: lokasi default dibuat otomatis bila belum ada.
        const lokasi = await lokasiGudang(Number(p.warehouse_id), pengguna.id);

        // 1) Stok masuk per produk (SATU-JALUR ubahStok → kartu stok ikut).
        for (const it of items) {
          const qtyDasar = await konversiKeDasar(it);
          if (!(qtyDasar > 0)) throw tolak(400, `Qty produk ${it.sku} tidak masuk akal setelah konversi satuan.`);
          await ubahStok({
            productId: it.product_id,
            warehouseId: Number(p.warehouse_id),
            locationId: it.location_id ?? lokasi,
            masuk: qtyDasar,
            hargaMasuk: qtyDasar > 0 ? Number(it.subtotal) / qtyDasar : undefined,
            tipeDokumen: 'pembelian',
            dokumenId: id,
            userId: pengguna.id,
          });
        }

        // 2) AKUNTANSI DASAR — tanpa jurnal. Pembelian tercatat sebagai hutang
        //    pemasok (di bawah); kas baru bergerak saat pembayaran hutang
        //    dilakukan (otomatis Kas Keluar). Stok sudah diubah di atas.

        // 3) Hutang pemasok (faktur): jatuh tempo dari input atau termin pemasok.
        let tempo = jatuhTempo;
        if (!tempo) {
          const s = await get<{ termin_hari: number }>(`SELECT termin_hari FROM suppliers WHERE id = ?`, Number(p.supplier_id));
          const termin = Number(s?.termin_hari ?? 0);
          if (termin > 0) {
            tempo = new Date(Date.now() + termin * 86400000).toISOString().slice(0, 10);
          }
        }
        await run(
          `INSERT INTO payables (purchase_id, supplier_id, jatuh_tempo, total, status, dibuat_oleh)
           VALUES (?, ?, ?, ?, 'belum', ?)`,
          id,
          Number(p.supplier_id),
          tempo,
          Number(p.total),
          pengguna.id,
        );

        const sekarang = new Date().toISOString();
        await run(
          `UPDATE purchases SET status = 'disahkan', no_faktur = ?, disahkan_pada = ?, diubah_pada = ? WHERE id = ?`,
          noFaktur,
          sekarang,
          sekarang,
          id,
        );
        // BAGIAN I: faktur disusun otomatis saat pengesahan (termasuk dokumen
        // yang lahir dari mode Chatbot) — nomor urut dari Pengaturan.
        const fakturBaru = await buatFakturPembelian(id, pengguna.id);
        faktur = fakturBaru;
        await catatAudit({
          userId: pengguna.id,
          aksi: 'sahkan',
          tabel: 'purchases',
          recordId: id,
          sebelum: { status: 'diterima' },
          sesudah: {
            status: 'disahkan',
            no_faktur: noFaktur,
            total: p.total,
            faktur_otomatis: fakturBaru?.no_faktur ?? null,
          },
        });
        });
      } finally {
        kunciLepas(id);
      }

      res.json({ ok: true, data: await bacaPembelian(id), faktur: faktur ?? undefined });
    }),
  );

  // ==========================================================================
  // AW3 — Batal & Pulihkan dalam satu transaksi database.
  // Draft/diterima → Dibatalkan (tanpa efek stok/jurnal).
  // Disahkan → cek stok cukup, gerakan pembalik di kartu stok
  // ("Pembatalan <no. dokumen>"), hutang berkurang, status Dibatalkan.
  // ==========================================================================
  r.post(
    '/:id/batal',
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const pengguna = penggunaSaatIni(req);
      const alasan = String((req.body ?? {}).alasan ?? '').trim();
      if (!kunciAmbil(id)) throw tolak(409, 'Dokumen sedang diproses — tunggu sebentar lalu muat ulang.');
      try {
        const awalB = await get<Record<string, unknown>>(`SELECT * FROM purchases WHERE id = ?`, id);
        if (!awalB) throw tolak(404, 'Dokumen pembelian tidak ditemukan.');
        const dariDisahkan = String(awalB.status) === 'disahkan';
        // AX2 — Batal draft/GRN = sel Hapus; Batal & Pulihkan dokumen yang
        // sudah disahkan (membalik posting) = sel Hapus DAN Sahkan.
        if (dariDisahkan) await wajibSel(req, 'pembelian', 'hapus', 'sahkan');
        else await wajibSel(req, 'pembelian', 'hapus');
        if (dariDisahkan && !alasan) throw tolak(400, 'Alasan pembatalan wajib diisi untuk Batal & Pulihkan.');
        const alasanSimpan = alasan || `Batal ${String(awalB.status)} ${String(awalB.no_dokumen ?? '')}`.trim();

        await withTransaction(async () => {
          const p = await get<Record<string, unknown>>(`SELECT * FROM purchases WHERE id = ?`, id);
          if (!p) throw tolak(404, 'Dokumen pembelian tidak ditemukan.');
          await wajibGudangDiizinkan(req, Number(p.warehouse_id));
          if (p.status === 'batal') throw tolak(409, 'Dokumen sudah dibatalkan. Alasan: status saat ini "batal".');

          if (p.status === 'disahkan') {
            // 0) Hutang sudah dibayar sebagian tidak boleh dipulihkan langsung.
            const hut = await get<{ terbayar: number; status: string }>(`SELECT terbayar, status FROM payables WHERE purchase_id = ?`, id);
            if (hut && Number(hut.terbayar) > 0) {
              throw tolak(409, `Pembatalan ditolak: hutang sudah dibayar sebagian (terbayar Rp ${Number(hut.terbayar)}). Batalkan pembayaran hutang dulu.`);
            }
            // 1) Periksa stok masih cukup untuk ditarik di gudang/lokasi dokumen.
            const gerak = await all<{ product_id: number; qty: number; sku: string }>(
              `SELECT l.product_id, SUM(l.qty_masuk) - SUM(l.qty_keluar) AS qty, MAX(pr.sku) AS sku
               FROM stock_ledger l JOIN products pr ON pr.id = l.product_id
               WHERE l.tipe_dokumen IN ('pembelian', 'pembelian_batal') AND l.dokumen_id = ?
               GROUP BY l.product_id`,
              id,
            );
            // Cek saldo kini per produk di gudang dokumen (id, bukan teks).
            const kurang: string[] = [];
            for (const m of gerak) {
              if (!(m.qty > 0)) continue;
              const saldo = await get<{ qty: number }>(`SELECT COALESCE(SUM(qty),0) AS qty FROM stock_balances WHERE product_id = ? AND warehouse_id = ?`, m.product_id, Number(p.warehouse_id));
              if (Number(saldo?.qty ?? 0) < Number(m.qty) - 1e-9) {
                kurang.push(`${m.sku ?? m.product_id} (butuh ${m.qty}, tersedia ${saldo?.qty ?? 0})`);
              }
            }
            if (kurang.length > 0) {
              throw tolak(409, `Pembatalan ditolak: stok sudah terpakai transaksi lain — ${kurang.join('; ')}. Selesaikan lewat Opname atau kembalikan stok dulu.`);
            }
            // 2) Gerakan pembalik di kartu stok (riwayat asli tetap, bertanda pembatalan).
            for (const m of gerak) {
              if (m.qty > 0) {
                await ubahStok({
                  productId: m.product_id,
                  warehouseId: Number(p.warehouse_id),
                  keluar: m.qty,
                  tipeDokumen: 'pembelian_batal',
                  dokumenId: id,
                  userId: pengguna.id,
                });
              }
            }
            // 3) Hutang berkurang / dibatalkan (jurnal asli tidak dihapus).
            await run(
              `UPDATE payables SET status = 'batal', diubah_pada = ? WHERE purchase_id = ? AND status <> 'batal'`,
              new Date().toISOString(),
              id,
            );
          }

          await run(`UPDATE purchases SET status = 'batal', diubah_pada = ? WHERE id = ?`, new Date().toISOString(), id);
          await catatAudit({
            userId: pengguna.id,
            aksi: 'batal',
            tabel: 'purchases',
            recordId: id,
            sebelum: { status: p.status },
            sesudah: { status: 'batal', batal_disahkan: dariDisahkan },
            alasan: alasanSimpan,
          });
        });
      } catch (err) {
        const { pesan } = pesanKesalahan(err);
        if (pesan.includes('Stok tidak mencukupi')) {
          throw tolak(409, `Pembatalan gagal: stok hasil pembelian sudah terpakai transaksi lain. Selesaikan lewat Opname. (${pesan})`);
        }
        throw err;
      } finally {
        kunciLepas(id);
      }

      res.json({ ok: true, data: await bacaPembelian(id) });
    }),
  );

  // ==========================================================================
  // AW4 — Buat draft baru dari dokumen (setelah dibatalkan maupun lainnya).
  // Nomor baru; tidak menggandakan dokumen; perubahan tercatat di log.
  // ==========================================================================
  r.post(
    '/:id/salin',
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const pengguna = penggunaSaatIni(req);
      const asal = await get<Record<string, unknown>>(`SELECT * FROM purchases WHERE id = ?`, id);
      if (!asal) throw tolak(404, 'Dokumen pembelian tidak ditemukan.');
      // AX2 — Salin ke draft baru = sel Tambah pada Pembelian.
      await wajibSel(req, 'pembelian', 'tambah');
      const items = await all<Record<string, unknown>>(`SELECT product_id, qty, unit_id, harga_beli, diskon, pack_id, sumber_scan FROM purchase_items WHERE purchase_id = ? ORDER BY id`, id);
      if (items.length === 0) throw tolak(400, 'Dokumen asal tanpa item — tidak bisa disalin.');
      const isi = {
        metode: String(asal.metode_input ?? 'biasa'),
        supplier_id: Number(asal.supplier_id),
        warehouse_id: Number(asal.warehouse_id),
        tanggal: new Date().toISOString(),
        no_po: null as string | null,
        pajak_persen: Number(asal.pajak_persen ?? 0),
        items: items.map((i) => ({
          product_id: Number(i.product_id),
          qty: Number(i.qty),
          unit_id: i.unit_id ? Number(i.unit_id) : null,
          harga_beli: Number(i.harga_beli ?? 0),
          diskon: Number(i.diskon ?? 0),
          pack_id: i.pack_id ? Number(i.pack_id) : null,
          sumber_scan: i.sumber_scan ? String(i.sumber_scan) : null,
        })),
      };
      const t = hitungTotal(isi.items as BarisMasuk[], isi.pajak_persen);
      const idBaru = await withTransaction(async () => {
        const noDok = await nomorDokumen('PB');
        const nid = Number(
          await ((await run(
            `INSERT INTO purchases (no_dokumen, no_po, tanggal, supplier_id, warehouse_id, metode_input, subtotal, diskon, pajak_persen, pajak, total, status, dibuat_oleh)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`,
            noDok, isi.no_po, isi.tanggal, isi.supplier_id, isi.warehouse_id, isi.metode,
            t.subtotal, t.diskon, isi.pajak_persen, t.pajak, t.total, pengguna.id,
          ))).lastInsertRowid,
        );
        for (const i of isi.items) await tulisItem(nid, i as BarisMasuk);
        await catatAudit({
          userId: pengguna.id,
          aksi: 'tambah',
          tabel: 'purchases',
          recordId: nid,
          sesudah: { no_dokumen: noDok, salin_dari: id, items: isi.items.length, total: t.total },
          alasan: `Salin dari ${String(asal.no_dokumen ?? id)}`,
        });
        return nid;
      });
      res.status(201).json({ id: idBaru, data: await bacaPembelian(idBaru) });
    }),
  );

  return r;
}

/** Qty dalam SATUAN DASAR (konversi unit_conversions bila berbeda). */
async function konversiKeDasar(it: { product_id: number; qty: number; unit_id: number | null; satuan_dasar_id: number | null; sku: string }): Promise<number> {
  if (!it.unit_id || !it.satuan_dasar_id || Number(it.unit_id) === Number(it.satuan_dasar_id)) return Number(it.qty);
  const k = await get<{ jumlah_per_satuan_dasar: number }>(
    `SELECT jumlah_per_satuan_dasar FROM unit_conversions WHERE product_id = ? AND unit_id = ?`,
    it.product_id,
    it.unit_id,
  );
  if (!k) throw tolak(400, `Satuan item ${it.sku} belum dikonversi ke satuan dasar — lengkapi di Master › Konversi Satuan.`);
  return Number(it.qty) * Number(k.jumlah_per_satuan_dasar);
}

async function tulisItem(purchaseId: number, i: BarisMasuk): Promise<void> {
  // Snapshot nama & SKU saat transaksi — riwayat tetap utuh walau master berubah.
  const pr = await get<{ nama: string; sku: string }>(`SELECT nama, sku FROM products WHERE id = ?`, i.product_id);
  if (!pr) throw tolak(400, 'Produk tidak ditemukan.');
  await run(
    `INSERT INTO purchase_items (purchase_id, product_id, nama_produk, sku, qty, unit_id, harga_beli, diskon, subtotal, pack_id, sumber_scan)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    purchaseId,
    i.product_id,
    pr.nama,
    pr.sku,
    i.qty,
    i.unit_id,
    i.harga_beli,
    i.diskon,
    i.qty * i.harga_beli - i.diskon,
    i.pack_id,
    i.sumber_scan,
  );
}
