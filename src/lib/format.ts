// Utilitas format sesuai standar Indonesia:
// Rupiah "Rp 1.250.000", angka "1.250.000", tanggal "dd/mm/yyyy".

const RUPIAH = new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const ANGKA = new Intl.NumberFormat('id-ID', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/** Rp 1.250.000 */
export function formatRupiah(nilai: number | null | undefined): string {
  return RUPIAH.format(nilai ?? 0);
}

/** 1.250.000 */
export function formatAngka(nilai: number | null | undefined): string {
  return ANGKA.format(nilai ?? 0);
}

function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 08/10/2026 */
export function formatTanggal(value: Date | string | number | null | undefined): string {
  const d = toDate(value);
  if (!d) return '—';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/** 08/10/2026 14:35 */
export function formatTanggalWaktu(value: Date | string | number | null | undefined): string {
  const d = toDate(value);
  if (!d) return '—';
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${formatTanggal(d)} ${hh}:${mi}`;
}

/** Senin, 8 Oktober 2026 */
export function formatTanggalPanjang(value: Date | string | number | null | undefined): string {
  const d = toDate(value);
  if (!d) return '—';
  return new Intl.DateTimeFormat('id-ID', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(d);
}
