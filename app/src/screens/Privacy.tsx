import { BRAND } from '../brand';
import { useT } from '../i18n';
import './Prose.css';

const COLLECT = ['report', 'contact', 'device', 'offline'] as const;
const WHO = ['city', 'infra', 'team', 'sold'] as const;
const RETENTION = ['photo', 'record', 'city'] as const;
const CHOICES = ['anon', 'delete'] as const;

export default function Privacy() {
  const t = useT();
  const email = <a href={`mailto:${BRAND.contactEmail}`}>{BRAND.contactEmail}</a>;

  const list = (section: string, keys: readonly string[]) => (
    <ul>
      {keys.map((k) => (
        <li key={k}>
          <span className="lead">{t(`privacy.${section}.${k}.t`)}</span> {t(`privacy.${section}.${k}.b`)}
        </li>
      ))}
    </ul>
  );

  return (
    <article className="prose section" aria-labelledby="privacy-title">
      <h1 id="privacy-title">{t('privacy.title')}</h1>
      <p className="lede">{t('privacy.tagline')}</p>
      <p>{t('privacy.intro')}</p>

      <div className="prose-callout" role="note">
        <p>{t('privacy.record.p1')}</p>
      </div>

      <h2>{t('privacy.collect.h')}</h2>
      {list('collect', COLLECT)}

      <h2>{t('privacy.token.h')}</h2>
      <p>{t('privacy.token.p1')}</p>

      <h2>{t('privacy.storage.h')}</h2>
      <p>{t('privacy.storage.p1')}</p>

      <h2>{t('privacy.who.h')}</h2>
      {list('who', WHO)}

      <h2>{t('privacy.retention.h')}</h2>
      {list('retention', RETENTION)}

      <h2>{t('privacy.choices.h')}</h2>
      {list('choices', CHOICES)}

      <h2>{t('privacy.children.h')}</h2>
      <p>{t('privacy.children.p1')}</p>

      <h2>{t('privacy.changes.h')}</h2>
      <p>{t('privacy.changes.p1')}</p>

      <h2>{t('privacy.contact.h')}</h2>
      <p>{t('privacy.contact.p1')} {email}.</p>

      <p className="prose-updated">{t('privacy.updated')}</p>
    </article>
  );
}
