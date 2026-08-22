import { Link } from 'react-router-dom';
import { listMyReports } from '../lib/myReports';
import { byKey } from '../lib/categories';
import { useT } from '../i18n';
import CategoryIcon from '../components/CategoryIcon';
import Illustration from '../components/Illustration';
import AccountReports from '../components/AccountReports';

export default function MyReports() {
  const t = useT();
  const items = listMyReports();
  return (
    <section className="section">
      <h2>{t('header.myReports')}</h2>
      <AccountReports />
      {items.length === 0 ? (
        <div className="empty rise">
          <Illustration kind="empty" className="illo" />
          <h2>{t('empty.my.title')}</h2>
          <p className="muted">{t('my.empty')}</p>
          <Link className="btn btn-primary" to="/">{t('empty.my.cta')}</Link>
        </div>
      ) : (
        <ul className="my-list">
          {items.map((r) => (
            <li key={r.id}><Link to={`/r/${r.id}`} className="card my-row rise">
              <span className="my-icon" aria-hidden="true"><CategoryIcon k={r.category} size={36} /></span>
              <span className="my-cat">{byKey(r.category)?.short ?? r.category}</span>
              <span className="my-addr">{r.address}</span>
              <span className="muted my-date">{new Date(r.createdAt).toLocaleDateString()}</span>
            </Link></li>
          ))}
        </ul>
      )}
    </section>
  );
}
