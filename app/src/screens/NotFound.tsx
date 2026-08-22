import { Link } from 'react-router-dom';
import { useT } from '../i18n';

export default function NotFound() {
  const t = useT();
  return (
    <section className="section">
      <h2>{t('notFound.title')}</h2>
      <p className="muted">{t('notFound.body')}</p>
      <Link className="btn btn-primary" to="/">{t('notFound.home')}</Link>
    </section>
  );
}
