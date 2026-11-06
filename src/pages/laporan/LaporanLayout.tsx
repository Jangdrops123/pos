import { Outlet } from 'react-router-dom';
import { FilterBar } from './FilterBar';
import { FilterProvider } from './filter';
import './laporan.css';

/**
 * Kerangka modul Laporan (N1/N2): satu FilterProvider untuk seluruh subtree,
 * sehingga filter & periode bertahan saat berpindah antar laporan dan selalu
 * tercermin di query URL.
 */
export function LaporanLayout() {
  return (
    <FilterProvider>
      <div className="halaman laporan-shell">
        <FilterBar />
        <Outlet />
      </div>
    </FilterProvider>
  );
}
