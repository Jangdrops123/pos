import { useEffect, useState } from 'react';

/** Format tanggal + jam transaksi dalam Bahasa Indonesia, mis. "Kamis, 29 Okt 2026 • 15:25:00 WIB". */
export function formatWaktuTransaksi(now: Date): string {
  const dateStr = now.toLocaleDateString('id-ID', {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const jam = String(now.getHours()).padStart(2, '0');
  const menit = String(now.getMinutes()).padStart(2, '0');
  const detik = String(now.getSeconds()).padStart(2, '0');
  return `${dateStr} • ${jam}:${menit}:${detik} WIB`;
}

/** Live clock 1 detik — dipakai widget tanggal & jam transaksi di header POS. */
export function useJamTransaksi(): string {
  const [teks, setTeks] = useState(() => formatWaktuTransaksi(new Date()));
  useEffect(() => {
    const t = window.setInterval(() => setTeks(formatWaktuTransaksi(new Date())), 1000);
    return () => window.clearInterval(t);
  }, []);
  return teks;
}

/**
 * Widget Tanggal & Jam Transaksi — diletakkan di header POS, di sebelah kiri
 * tombol "Riwayat & Layanan" / bersandingan dengan badge status shift.
 */
export function JamTransaksi() {
  const teks = useJamTransaksi();
  return (
    <div className="pos-datetime" role="timer" aria-label="Tanggal dan jam transaksi">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <span id="pos-transaction-datetime">{teks}</span>
    </div>
  );
}
