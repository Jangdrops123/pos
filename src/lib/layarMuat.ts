// BAGIAN AI2/AI5 — Jembatan ke layar muat di index.html.
//
// `selesaikanLayarMuat()` dipanggil setelah React merender tampilan pertama:
// layar muat menunggu minimal 400 ms lalu memudar 200 ms. `putarLayarMuat()`
// memperlihatkan layar muat dengan data formulir Identitas Aplikasi yang
// sedang diisi (tanpa memuat ulang aplikasi) — memakai CSS yang sama dengan
// layar muat asli agar pratinjaunya jujur.
import { PALET_AKSEN, type KodeAksen } from './aksen';

interface GlobalLayarMuat {
  __layarMuatSelesai?: () => void;
}

/** Tutup layar muat asli (idempoten — aman dipanggil StrictMode dua kali). */
export function selesaikanLayarMuat(): void {
  if (typeof window === 'undefined') return;
  const f = (window as unknown as GlobalLayarMuat).__layarMuatSelesai;
  if (typeof f === 'function') f();
}

export interface DataLayarMuat {
  nama: string;
  tagline: string;
  logo: string;
  aksen: string;
  tema: 'siang' | 'malam';
}

/** URL logo yang aman: data URL gambar atau path internal. */
export function logoAman(url: string | null | undefined): string {
  const u = (url ?? '').trim();
  if (!u) return '';
  if (/^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,/i.test(u)) return u.length <= 100000 ? u : '';
  if (u.length > 4096) return '';
  if (u.startsWith('/') && !u.startsWith('//') && !u.startsWith('/\\')) return u;
  return '';
}

/**
 * Pratinjau layar muat (tombol ikon "Putar layar muat"): tampil 1,6 detik di
 * atas aplikasi lalu memudar. Hanya satu pratinjau pada satu waktu.
 */
export function putarLayarMuat(data: DataLayarMuat): void {
  if (typeof document === 'undefined') return;
  document.querySelector('.layar-muat--putar')?.remove();

  const nama = (data.nama || '').trim().slice(0, 60) || 'Aplikasi';
  const tagline = (data.tagline || '').trim().slice(0, 80);
  const palet = PALET_AKSEN[(data.aksen || '') as KodeAksen] ?? PALET_AKSEN[''];
  const [awal, akhir] = data.tema === 'malam' ? palet.malam : palet.siang;
  const inisial = nama.charAt(0).toUpperCase();

  const wadah = document.createElement('div');
  wadah.className = 'layar-muat layar-muat--putar layar-muat--pudar';
  wadah.dataset.tema = data.tema;
  wadah.setAttribute('role', 'status');
  wadah.setAttribute('aria-busy', 'true');
  wadah.setAttribute('aria-label', `Pratinjau layar muat: ${nama}`);
  wadah.style.setProperty('--lm-aksen', awal);
  wadah.style.setProperty('--lm-aksen-2', akhir);

  const logo = document.createElement('div');
  logo.className = 'layar-muat__logo';
  const sumber = logoAman(data.logo);
  if (sumber) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = sumber;
    img.addEventListener('error', () => {
      img.remove();
      logo.classList.remove('layar-muat__logo--gambar');
      logo.textContent = inisial;
    });
    logo.appendChild(img);
    logo.classList.add('layar-muat__logo--gambar');
  } else {
    logo.textContent = inisial;
  }

  const isi = document.createElement('div');
  isi.className = 'layar-muat__isi';
  const elNama = document.createElement('div');
  elNama.className = 'layar-muat__nama';
  elNama.textContent = nama;
  elNama.title = nama;
  isi.appendChild(elNama);
  if (tagline) {
    const elTagline = document.createElement('div');
    elTagline.className = 'layar-muat__tagline';
    elTagline.textContent = tagline;
    elTagline.title = tagline;
    isi.appendChild(elTagline);
  }

  const bilah = document.createElement('div');
  bilah.className = 'layar-muat__bilah';
  bilah.setAttribute('aria-hidden', 'true');

  wadah.append(logo, isi, bilah);
  document.body.appendChild(wadah);

  // Fade masuk → tahan → fade keluar (CSS: 200 ms, hormati reduced-motion).
  requestAnimationFrame(() => wadah.classList.remove('layar-muat--pudar'));
  window.setTimeout(() => {
    wadah.classList.add('layar-muat--pudar');
    window.setTimeout(() => wadah.remove(), 260);
  }, 1600);
}
