import { Link } from 'react-router-dom';
import { listMyReports } from '../lib/myReports';
import { byKey } from '../lib/categories';
import { useT } from '../i18n';

export default function MyReports() {
  const t = useT();
  const items = listMyReports();
  return (
    <section className="section">
      <h2>{t('header.myReports')}</h2>
      {items.length === 0 ? <p className="muted">{t('my.empty')}</p> : (
        <ul className="my-list">
          {items.map((r) => (
            <li key={r.id}><Link to={`/r/${r.id}`} className="card my-row">
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
