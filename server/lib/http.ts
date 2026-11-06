import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Kesalahan HTTP dengan kode status yang bisa dikirim ke klien. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const tolak = (status: number, pesan: string): HttpError => new HttpError(status, pesan);

/** Bungkus handler async agar kesalahan diteruskan ke penangan error pusat. */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown): RequestHandler =>
  async (req, res, next) => {
    await Promise.resolve(fn(req, res, next) as Promise<unknown>).catch(next);
  };

export interface Paginasi {
  hal: number;
  per: number;
  offset: number;
  urut: string;
  arah: 'ASC' | 'DESC';
  cari: string;
}

/** Baca parameter daftar: halaman, ukuran, urutan, kata kunci (aman dari injeksi). */
export function bacaPaginasi(
  req: Request,
  opsi: { urutBawaan: string; arahBawaan?: 'ASC' | 'DESC'; perBawaan?: number; urutDiizinkan: string[] },
): Paginasi {
  const q = req.query;
  const hal = Math.max(1, Number.parseInt(String(q.hal ?? '1'), 10) || 1);
  const per = Math.min(200, Math.max(1, Number.parseInt(String(q.per ?? '20'), 10) || opsi.perBawaan || 20));
  const urutMinta = String(q.urut ?? '');
  const urut = opsi.urutDiizinkan.includes(urutMinta) ? urutMinta : opsi.urutBawaan;
  const arahMinta = String(q.arah ?? '').toUpperCase();
  const arah: 'ASC' | 'DESC' = arahMinta === 'DESC' ? 'DESC' : arahMinta === 'ASC' ? 'ASC' : (opsi.arahBawaan ?? 'ASC');
  const cari = String(q.cari ?? '').trim();
  return { hal, per, offset: (hal - 1) * per, urut, arah, cari };
}

/** Pola pencarian LIKE yang aman (karakter khusus di-escape). */
export function polaCari(cari: string): string {
  return `%${cari.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/** Terjemahkan kesalahan SQLite menjadi pesan yang ramah pengguna. */
export function pesanKesalahan(err: unknown): { status: number; pesan: string } {
  const pesan = err instanceof Error ? err.message : String(err);

  if (err instanceof HttpError) return { status: err.status, pesan: err.message };

  const unik = /UNIQUE constraint failed:\s*([\w.]+)/i.exec(pesan);
  if (unik) {
    const kolom = unik[1].split('.').pop() ?? 'nilai';
    return { status: 409, pesan: `Nilai duplikat: kolom "${kolom}" sudah dipakai data lain.` };
  }
  if (/FOREIGN KEY constraint failed/i.test(pesan)) {
    return { status: 409, pesan: 'Data terkait masih dipakai atau referensinya belum ada. Periksa pilihan Anda.' };
  }
  if (/CHECK constraint failed/i.test(pesan)) {
    return { status: 400, pesan: `Nilai tidak sesuai aturan basis data: ${pesan.replace(/^.*CHECK constraint failed:\s*/i, '')}` };
  }
  // Pesan dari trigger RAISE(ABORT, '...') — langsung tampil.
  if (/SqliteError|ABORT/i.test(pesan) && !/constraint failed/i.test(pesan)) {
    return { status: 409, pesan: pesan.replace(/^SqliteError:\s*/i, '') };
  }
  return { status: 500, pesan };
}
