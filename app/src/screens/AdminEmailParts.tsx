import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useT } from '../i18n';
import { adminEmail, type AdminEmail, type AdminEmailRow } from '../api/admin';
import { When, abs } from './adminUtil';

type Tr = ReturnType<typeof useT>;

/** Who the mail is about, in one word group: To people · To the city · To you · Inbound. */
export const KIND_GROUPS: { key: string; kinds: AdminEmailRow['kind'][] }[] = [
  { key: 'people', kinds: ['filed', 'status', 'city_copy', 'ask', 'ask_reminder', 'answer_receipt', 'not_sent', 'street_digest', 'city_follow', 'reporter_other'] },
  { key: 'city', kinds: ['to_city'] },
  { key: 'you', kinds: ['admin_review', 'admin_alert', 'admin_digest'] },
  { key: 'inbound', kinds: ['city_in', 'reply_in', 'unmatched_in', 'dropped_in'] },
];

/** Delivery in a word: Resend's last event for mail we sent, our own status otherwise. `tone` drives the colour. */
export function delivery(e: Pick<AdminEmailRow, 'dir' | 'status' | 'lastEvent'>, t: Tr): { label: string; tone: 'ok' | 'warn' | 'error' | 'muted' } {
  if (e.dir === 'in') return e.status === 'dropped' ? { label: t('admin.email.status.dropped'), tone: 'muted' } : { label: t('admin.email.status.received'), tone: 'muted' };
  if (e.status === 'failed') return { label: t('admin.email.status.failed'), tone: 'error' };
  if (e.status === 'skipped') return { label: t('admin.email.status.skipped'), tone: 'muted' };
  const ev = e.lastEvent ?? '';
  if (ev === 'bounced' || ev === 'complained' || ev === 'failed') return { label: t(`admin.email.event.${ev}`), tone: 'error' };
  if (ev === 'delivery_delayed') return { label: t('admin.email.event.delivery_delayed'), tone: 'warn' };
  if (ev === 'delivered' || ev === 'opened' || ev === 'clicked') return { label: t(`admin.email.event.${ev}`), tone: 'ok' };
  return { label: t('admin.email.event.sent'), tone: 'muted' };
}

export const DeliveryPill = ({ e, t }: { e: Pick<AdminEmailRow, 'dir' | 'status' | 'lastEvent'>; t: Tr }) => {
  const d = delivery(e, t);
  return <span className={`email-pill email-pill--${d.tone}`}>{d.label}</span>;
};

export const KindChip = ({ kind, t }: { kind: AdminEmailRow['kind']; t: Tr }) => <span className={`email-kind email-kind--${kind}`}>{t(`admin.email.kind.${kind}`)}</span>;

/** The other party of a mail, short: "→ owner@example.com" for sent, "← pvd311@providenceri.gov" for received. */
export function counterpart(e: Pick<AdminEmailRow, 'dir' | 'from' | 'to'>): string {
  return e.dir === 'in' ? `← ${e.from}` : `→ ${e.to.join(', ')}`;
}

/**
 * Compact email list for the report pane and a person's profile: newest first, each row opens the mail in the Email
 * tab (`#email:<id>`). `showWho` adds the other party (the report view mixes people; a person's view does not need it).
 */
export function EmailRows({ items, t, showWho }: { items: AdminEmailRow[]; t: Tr; showWho?: boolean }) {
  if (!items.length) return <p className="admin-meta">{t('admin.email.none')}</p>;
  return (
    <ul className="email-rows">
      {items.map((e) => (
        <li key={e.id}>
          <a className="email-row" href={`#email:${encodeURIComponent(e.id)}`}>
            <span className="email-row-top">
              <span className={`email-dir email-dir--${e.dir}`} aria-label={t(`admin.email.dir.${e.dir}`)}>{e.dir === 'in' ? '↓' : '↑'}</span>
              <KindChip kind={e.kind} t={t} />
              <span className="email-row-when"><When iso={e.at} t={t} /></span>
              <DeliveryPill e={e} t={t} />
            </span>
            <span className="email-row-subject">{e.subject || t('admin.email.noSubject')}</span>
            {showWho && <span className="admin-meta email-row-who">{counterpart(e)}</span>}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** One email in full: headers, what it is about (report, people), delivery, and the text. */
export function AdminEmailPane({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT();
  const [e, setE] = useState<AdminEmail | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let live = true;
    setE(null); setErr(false);
    adminEmail(id).then((x) => { if (live) setE(x); }).catch(() => { if (live) setErr(true); });
    return () => { live = false; };
  }, [id]);

  return (
    <aside className="admin-pane email-pane" aria-label={t('admin.email.pane')}>
      <div className="admin-pane-head">
        {e ? <KindChip kind={e.kind} t={t} /> : <span className="admin-meta">{t('account.loading')}</span>}
        {e && <DeliveryPill e={e} t={t} />}
        <button type="button" className="btn btn-ghost admin-pane-close" onClick={onClose} aria-label={t('admin.pane.close')}>✕</button>
      </div>
      <div className="admin-pane-body">
        {err && <div className="notice notice-error" role="alert">{t('admin.loadError')}</div>}
        {e && (
          <>
            <h2 className="email-subject">{e.subject || t('admin.email.noSubject')}</h2>
            <dl className="admin-dl">
              <dt>{t('admin.email.when')}</dt><dd><When iso={e.at} t={t} /> <span className="admin-meta">{abs(e.at)}</span></dd>
              <dt>{t('admin.email.from')}</dt><dd>{e.from}</dd>
              <dt>{t('admin.email.to')}</dt><dd>{e.to.join(', ')}</dd>
              {e.replyTo && <><dt>{t('admin.email.replyTo')}</dt><dd>{e.replyTo}</dd></>}
              <dt>{t('admin.email.delivery')}</dt>
              <dd>
                <DeliveryPill e={e} t={t} />
                {e.lastEventAt && e.dir === 'out' && <span className="admin-meta"> · {abs(e.lastEventAt)}</span>}
                {e.error && <div className="admin-meta">{e.error}</div>}
              </dd>
              {e.outcome && <><dt>{t('admin.email.outcome')}</dt><dd>{e.outcome}</dd></>}
              {e.cityKind && <><dt>{t('admin.email.cityKind')}</dt><dd>{t(`admin.email.city.${e.cityKind}`)}</dd></>}
              {e.report && (
                <>
                  <dt>{t('admin.email.report')}</dt>
                  <dd>
                    <a href={`#reports?q=${encodeURIComponent(e.report.id)}`}>{e.report.categoryLabel} · {e.report.address}</a>
                    <div className="admin-meta">{[e.report.portalCaseId, e.report.portalStatus ?? t(`admin.status.${e.report.status}`)].filter(Boolean).join(' · ')} · <Link to={`/r/${e.report.id}`} target="_blank">{t('admin.email.trackingPage')}</Link></div>
                  </dd>
                </>
              )}
              {!e.report && e.caseId && <><dt>{t('admin.email.case')}</dt><dd>{e.caseId}</dd></>}
              {e.accounts.length > 0 && (
                <>
                  <dt>{t('admin.email.people')}</dt>
                  <dd>{e.accounts.map((a) => <div key={a.uid}><a href={`#accounts:${encodeURIComponent(a.uid)}`}>{a.email ?? a.uid}</a></div>)}</dd>
                </>
              )}
            </dl>
            <h3 className="label">{t('admin.email.text')}</h3>
            {e.text ? <pre className="email-text">{e.text}</pre> : <p className="admin-meta">{t('admin.email.noText')}</p>}
            {e.source === 'import' && <p className="admin-meta">{t('admin.email.imported')}</p>}
          </>
        )}
      </div>
    </aside>
  );
}
