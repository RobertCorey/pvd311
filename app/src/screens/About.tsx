import { Link } from 'react-router-dom';
import { BRAND } from '../brand';
import { useT } from '../i18n';
import './Prose.css';

const FLOW = ['1', '2', '3', '4'] as const;

export default function About() {
  const t = useT();
  const portalHost = BRAND.portalUrl.replace(/^https?:\/\//, '');
  const portal = (
    <a href={BRAND.portalUrl} target="_blank" rel="noopener">{portalHost}</a>
  );
  const email = <a href={`mailto:${BRAND.contactEmail}`}>{BRAND.contactEmail}</a>;

  return (
    <article className="prose section" aria-labelledby="about-title">
      <h1 id="about-title">{t('about.title')}</h1>
      <p className="lede">{t('about.tagline')}</p>

      <h2>{t('about.what.h')}</h2>
      <p>{t('about.what.p1')}</p>

      <h2>{t('about.who.h')}</h2>
      <p>{t('about.who.p1')} {portal}.</p>

      <h2>{t('about.flow.h')}</h2>
      <ol>
        {FLOW.map((n) => (
          <li key={n}>
            <span className="lead">{t(`about.flow.${n}.t`)}</span> {t(`about.flow.${n}.b`)}
          </li>
        ))}
      </ol>

      <div className="prose-callout warn" role="note">
        <p><strong>{t('about.emergency.h')}.</strong> {t('about.emergency.p1')}</p>
      </div>

      <h2>{t('about.record.h')}</h2>
      <p>{t('about.record.p1')}</p>
      <p>{t('about.record.see')} <Link to="/privacy">{t('nav.privacy')}</Link> {t('about.record.for')}</p>

      <h2>{t('about.seasonal.h')}</h2>
      <p>{t('about.seasonal.p1')}</p>

      <h2>{t('about.diy.h')}</h2>
      <p>{t('about.diy.pre')} {portal}{t('about.diy.post')}</p>

      <h2>{t('about.contact.h')}</h2>
      <p>{t('about.contact.p1')} {email}.</p>
    </article>
  );
}
