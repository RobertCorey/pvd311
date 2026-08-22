import { Link } from 'react-router-dom';
import { useT } from '../i18n';
import Illustration from '../components/Illustration';

export default function NotFound() {
  const t = useT();
  return (
    <section className="section">
      <div className="empty rise">
        <Illustration kind="lost" className="illo" />
        <h2>{t('notFound.title')}</h2>
        <p className="muted">{t('notFound.body')}</p>
        <Link className="btn btn-primary" to="/">{t('notFound.home')}</Link>
      </div>
    </section>
  );
}
