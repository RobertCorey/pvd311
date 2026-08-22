import { NavLink } from 'react-router-dom';
import { useT } from '../i18n';

const ICON = {
  mine: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h6" /></svg>,
  report: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>,
};

/** Phone bottom tabs: Report (ember) · Mine. Hidden by CSS while a report is in progress. */
export default function TabBar() {
  const t = useT();
  return (
    <nav className="tabbar" aria-label={t('nav.tabs')}>
      <div className="tabbar-inner">
        <NavLink to="/" end className="tab tab-cam"><span className="tab-cam-btn">{ICON.report}</span><span>{t('nav.report')}</span></NavLink>
        <NavLink to="/my" className="tab">{ICON.mine}<span>{t('nav.mine')}</span></NavLink>
      </div>
    </nav>
  );
}
