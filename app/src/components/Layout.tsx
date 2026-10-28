import { useEffect, type ReactNode } from 'react';
import { Link, useLocation, useNavigationType } from 'react-router-dom';
import { trackPageView } from '../lib/analytics';
import { BRAND } from '../brand';
import { useI18n } from '../i18n';
import BrandMark from './BrandMark';
import TabBar from './TabBar';
import Skyline from './Skyline';
import { useInstallPrompt } from '../lib/useInstallPrompt';
import AccountLink from './AccountLink';

/** The tab title per route, "<page> · FixMyPVD" (the home page and the rest: plain "FixMyPVD"). week/index.html and
 *  street/index.html (vite.config.ts) carry the same titles for link previews. */
const TITLES: Record<string, string> = {
  '/street': 'nav.street', '/week': 'week.title', '/my': 'header.myReports', '/account': 'header.accountIn',
  '/account/updates': 'account.tab.updates', '/about': 'nav.about', '/privacy': 'nav.privacy',
};

export default function Layout({ children }: { children: ReactNode }) {
  const { t, lang, setLang } = useI18n();
  const { canInstall, install } = useInstallPrompt();
  const { pathname } = useLocation();
  const navType = useNavigationType();
  const titleKey = TITLES[pathname.replace(/\/+$/, '')];
  useEffect(() => { document.title = titleKey ? `${t(titleKey)} · ${BRAND.name}` : BRAND.name; }, [titleKey, t]);
  useEffect(() => { trackPageView(); }, [pathname]);
  // A new page opens at its top; Back and Forward (POP) leave the scroll to the browser's own restoration.
  useEffect(() => { if (navType !== 'POP') window.scrollTo(0, 0); }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="app has-tabs">
      <header className="app-header">
        <Link to="/" className="wordmark" aria-label={BRAND.name}><BrandMark size={30} /><span aria-hidden="true">{BRAND.wordmark[0]}<em>{BRAND.wordmark[1]}</em></span></Link>
        <div className="header-actions">
          <Link to="/about" className="microtag">{t('header.notTheCity')}</Link>
          {canInstall && <button type="button" className="header-link header-btn" onClick={() => { void install(); }}>{t('header.install')}</button>}
          <Link to="/street" className="header-link header-street">{t('nav.street')}</Link>
          <Link to="/my" className="header-link header-my">{t('header.myReports')}</Link>
          <AccountLink className="header-link" />
        </div>
      </header>
      <main>{children}</main>
      <footer className="app-footer">
        <Skyline className="footer-skyline" />
        <nav aria-label={t('footer.nav')}>
          <Link to="/">{t('nav.report')}</Link>
          <Link to="/about">{t('nav.about')}</Link>
          <Link to="/privacy">{t('nav.privacy')}</Link>
          <a href={BRAND.portalUrl} target="_blank" rel="noopener">{t('nav.portal')}</a>
        </nav>
        <div className="lang-switch" role="group" aria-label={t('footer.language')}>
          <button type="button" className={`lang-btn${lang === 'en' ? ' active' : ''}`} onClick={() => setLang('en')} lang="en" aria-pressed={lang === 'en'}>English</button>
          <span aria-hidden="true">·</span>
          <button type="button" className={`lang-btn${lang === 'es' ? ' active' : ''}`} onClick={() => setLang('es')} lang="es" aria-pressed={lang === 'es'}>Español</button>
        </div>
        <p className="disclaimer">{t('brand.disclaimer')}</p>
        <p className="made-in">{t('footer.madeIn')}</p>
        <div className="footer-contact">{t('footer.contact')}: <a href={`mailto:${BRAND.contactEmail}`}>{BRAND.contactEmail}</a></div>
      </footer>
      <TabBar />
    </div>
  );
}
