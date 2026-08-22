import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { BRAND } from '../brand';
import { useT } from '../i18n';
import BrandMark from './BrandMark';

export default function Layout({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <div className="app">
      <header className="app-header">
        <Link to="/" className="wordmark" aria-label={BRAND.name}><BrandMark size={26} />{BRAND.name}</Link>
        <div className="header-actions">
          <span className="microtag">{BRAND.notTheCity}</span>
          <Link to="/my" className="header-link">{t('header.myReports')}</Link>
        </div>
      </header>
      <main>{children}</main>
      <footer className="app-footer">
        <nav aria-label="Site">
          <Link to="/">{t('nav.report')}</Link>
          <Link to="/map">{t('nav.map')}</Link>
          <Link to="/about">{t('nav.about')}</Link>
          <Link to="/privacy">{t('nav.privacy')}</Link>
          <a href={BRAND.portalUrl} target="_blank" rel="noopener">{t('nav.portal')}</a>
        </nav>
        <p className="disclaimer">{BRAND.disclaimer}</p>
        <div>{t('footer.contact')}: <a href={`mailto:${BRAND.contactEmail}`}>{BRAND.contactEmail}</a></div>
      </footer>
    </div>
  );
}
