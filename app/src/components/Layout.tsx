import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { BRAND } from '../brand';
import { useI18n } from '../i18n';
import BrandMark from './BrandMark';
import { useInstallPrompt } from '../lib/useInstallPrompt';

export default function Layout({ children }: { children: ReactNode }) {
  const { t, lang, setLang } = useI18n();
  const { canInstall, install } = useInstallPrompt();
  return (
    <div className="app">
      <header className="app-header">
        <Link to="/" className="wordmark" aria-label={BRAND.name}><BrandMark size={26} />{BRAND.name}</Link>
        <div className="header-actions">
          <span className="microtag">{BRAND.notTheCity}</span>
          {canInstall && <button type="button" className="header-link header-btn" onClick={() => { void install(); }}>{t('header.install')}</button>}
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
        <div className="lang-switch" role="group" aria-label="Language">
          <button type="button" className={`lang-btn${lang === 'en' ? ' active' : ''}`} onClick={() => setLang('en')} lang="en" aria-pressed={lang === 'en'}>English</button>
          <span aria-hidden="true">·</span>
          <button type="button" className={`lang-btn${lang === 'es' ? ' active' : ''}`} onClick={() => setLang('es')} lang="es" aria-pressed={lang === 'es'}>Español</button>
        </div>
        <p className="disclaimer">{BRAND.disclaimer}</p>
        <div>{t('footer.contact')}: <a href={`mailto:${BRAND.contactEmail}`}>{BRAND.contactEmail}</a></div>
      </footer>
    </div>
  );
}
