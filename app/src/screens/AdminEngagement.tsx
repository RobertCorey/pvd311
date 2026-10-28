import { useCallback, useEffect, useState } from 'react';
import { useT } from '../i18n';
import { adminEngagement, type AdminDigestRun, type AdminEngagement as Engagement, type AdminEvent } from '../api/admin';
import { When, abs, rel } from './adminUtil';
import { DeliveryPill, KindChip } from './AdminEmailParts';
import './AdminEngagement.css';

type Tr = ReturnType<typeof useT>;

/**
 * Engagement tab — who opted into what (push, follows, the two Monday digests), what last Monday's runs did, and the
 * recent digest / push events and mails. One GET /api/admin/engagement, counted on the Worker from a ≤ 500-account scan and cached a minute.
 * Desktop: tiles → two run cards → two tables. Phone: everything stacks; the mail table reuses the Email tab's cards.
 */
export default function AdminEngagement({ go }: { go: (hash: string) => void }) {
  const t = useT();
  const [d, setD] = useState<Engagement | null>(null);
  const [err, setErr] = useState(false);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try { setD(await adminEngagement()); setErr(false); } catch { setErr(true); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const quiet = !!d && !d.lastWeekDigest && !d.lastStreetDigest && d.recent.events.length === 0 && d.recent.mails.length === 0;
  const a = d?.accounts;
  return (
    <div className="admin-engagement">
      <div className="admin-filters">
        <p className="admin-meta eng-what">{t('admin.engagement.what')}</p>
        <button type="button" className="btn btn-ghost admin-refresh" onClick={load} disabled={loading}>{t('admin.refresh')}</button>
      </div>
      {err && <div className="notice notice-error" role="alert">{t('admin.loadError')}</div>}
      {!d || !a ? (!err && <p className="muted" aria-busy="true">{t('account.loading')}</p>) : (
        <>
          <p className="admin-meta eng-asof">
            {t('admin.engagement.asOf', { when: abs(d.at) })} · {a.truncated ? t('admin.engagement.scannedSome', { scanned: a.scanned, total: a.total }) : t('admin.engagement.scannedAll', { scanned: a.scanned })}
          </p>
          <div className="eng-tiles">
            <Tile n={a.total} label={t('admin.engagement.tile.accounts')} what={t('admin.engagement.tile.accountsWhat')} />
            <Tile n={a.pushDevices} label={t('admin.engagement.tile.push')} what={t('admin.engagement.tile.pushWhat', { n: a.withPush })} />
            <Tile n={a.follows.accounts} label={t('admin.engagement.tile.follows')} what={t('admin.engagement.tile.followsWhat', { n: a.follows.cases })} />
            <Tile n={a.streetDigest} label={t('admin.engagement.tile.streetDigest')} what={t('admin.engagement.tile.streetDigestWhat')} query={crossCheck(a, 'streetDigest', t)} />
            <Tile n={a.weekDigest} label={t('admin.engagement.tile.weekDigest')} what={t('admin.engagement.tile.weekDigestWhat')} query={crossCheck(a, 'weekDigest', t)} />
          </div>

          {quiet && <p className="admin-empty eng-empty">{t('admin.engagement.empty')}</p>}

          <section className="admin-section">
            <h2>{t('admin.engagement.lastMonday')}</h2>
            <div className="eng-cards">
              <RunCard kind="week" run={d.lastWeekDigest} t={t} />
              <RunCard kind="street" run={d.lastStreetDigest} t={t} />
            </div>
            <p className="admin-meta eng-vapid">{d.vapidSince ? t('admin.engagement.vapid', { when: abs(d.vapidSince) }) : t('admin.engagement.noVapid')}</p>
          </section>

          <section className="admin-section">
            <h2>{t('admin.engagement.events')}</h2>
            <p className="admin-meta">{t('admin.engagement.eventsWhat')}</p>
            {d.recent.events.length === 0 ? <p className="admin-empty">{t('admin.engagement.noEvents')}</p> : (
              <div className="admin-table-wrap">
                <table className="admin-table eng-events">
                  <thead><tr><th scope="col">{t('admin.sys.col.time')}</th><th scope="col">{t('admin.sys.col.kind')}</th><th scope="col">{t('admin.engagement.col.summary')}</th></tr></thead>
                  <tbody>
                    {d.recent.events.map((e) => (
                      <tr key={e.id}>
                        <td className="eng-time" title={abs(e.at)}><When iso={e.at} t={t} /></td>
                        <td className="eng-kind"><span className="sys-kind">{e.kind}</span></td>
                        <td className="eng-summary">{summarize(e, t)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="admin-section">
            <h2>{t('admin.engagement.mails')}</h2>
            <p className="admin-meta">{t('admin.engagement.mailsWhat')}</p>
            {d.recent.mails.length === 0 ? <p className="admin-empty">{t('admin.engagement.noMails')}</p> : (
              <div className="admin-table-wrap">
                <table className="admin-table admin-table--rows email-table eng-mails">
                  <thead>
                    <tr>
                      <th scope="col" className="email-td-when">{t('admin.email.col.when')}</th>
                      <th scope="col" className="email-td-kind">{t('admin.email.col.kind')}</th>
                      <th scope="col" className="email-td-who">{t('admin.email.col.who')}</th>
                      <th scope="col" className="email-td-subject">{t('admin.email.col.subject')}</th>
                      <th scope="col" className="email-td-delivery">{t('admin.email.col.delivery')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.recent.mails.map((m) => {
                      const open = () => go(`#email:${encodeURIComponent(m.id)}`);
                      return (
                        <tr key={m.id} tabIndex={0} onClick={open} onKeyDown={(ev) => { if (ev.key === 'Enter') open(); }}>
                          <td className="admin-td-age email-td-when" title={abs(m.at)}><span className="email-dir email-dir--out" aria-label={t('admin.email.dir.out')}>↑</span> <When iso={m.at} t={t} compact /></td>
                          <td className="admin-td-cat email-td-kind"><KindChip kind={m.kind} t={t} /></td>
                          <td className="admin-td-rep email-td-who">→ {m.to}</td>
                          <td className="admin-td-addr email-td-subject">{m.subject || t('admin.email.noSubject')}</td>
                          <td className="admin-td-status email-td-delivery"><DeliveryPill e={{ dir: 'out', status: m.status, lastEvent: null }} t={t} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

const Tile = ({ n, label, what, query }: { n: number; label: string; what: string; query?: string | null }) => (
  <div className="card eng-tile">
    <b>{n}</b>
    <span className="eng-tile-label">{label}</span>
    <span className="eng-tile-what">{what}</span>
    {query && <span className="eng-tile-query">{query}</span>}
  </div>
);

/** The equality-query count for an opt-in when it disagrees with the scan (a capped scan, or a query that saw more): the
 *  Monday jobs read the query, so that is the number that will actually be mailed. Nothing when they agree or no query ran. */
function crossCheck(a: Engagement['accounts'], k: 'streetDigest' | 'weekDigest', t: Tr): string | null {
  const q = a.queried?.[k];
  return typeof q === 'number' && q !== a[k] ? t('admin.engagement.tile.query', { n: q }) : null;
}

/** One Monday run: when, mailed of opted-in, pushes, and for the week digest the week's size and whether the post reached Rob. */
function RunCard({ kind, run, t }: { kind: 'week' | 'street'; run: AdminDigestRun | null; t: Tr }) {
  return (
    <div className={`card eng-card eng-card--${kind}`}>
      <h3 className="eng-card-title">{t(`admin.engagement.${kind}`)}</h3>
      {!run ? <p className="admin-meta eng-card-never">{t('admin.engagement.neverRan')}</p> : (
        <dl className="admin-dl">
          <dt>{t('admin.engagement.ran')}</dt><dd><time dateTime={run.at} title={abs(run.at)}>{rel(run.at, t)}</time> <span className="admin-meta">{abs(run.at)}</span></dd>
          <dt>{t('admin.engagement.mailed')}</dt><dd><b>{t('admin.engagement.mailedOf', { mailed: run.mailed, users: run.users })}</b></dd>
          <dt>{t('admin.engagement.pushed')}</dt><dd>{t('admin.engagement.pushes', { n: run.pushed })}</dd>
          {kind === 'week' && (
            <>
              <dt>{t('admin.engagement.cases')}</dt><dd>{run.total ?? 0}{(run.total ?? 0) === 0 && <span className="admin-meta"> · {t('admin.engagement.quietWeek')}</span>}</dd>
              <dt>{t('admin.engagement.post')}</dt><dd className="eng-post">{run.adminMailed ? t('admin.engagement.yes') : t('admin.engagement.no')}</dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}

/** One line from an event's `data` (the Worker's counts), falling back to its message. */
function summarize(e: Pick<AdminEvent, 'kind' | 'msg' | 'data'>, t: Tr): string {
  const d = e.data ?? {};
  const n = (k: string) => { const v = d[k]; return typeof v === 'number' && Number.isFinite(v) ? v : 0; };
  const has = (...ks: string[]) => ks.some((k) => k in d);
  switch (e.kind) {
    case 'week.digest': return has('users', 'mailed') ? t('admin.engagement.sum.week', { mailed: n('mailed'), users: n('users'), pushed: n('pushed'), total: n('total'), post: d.adminMailed ? t('admin.engagement.yes') : t('admin.engagement.no') }) : e.msg;
    case 'street.digest': return has('users', 'mailed') ? t('admin.engagement.sum.street', { mailed: n('mailed'), users: n('users'), pushed: n('pushed') }) : e.msg;
    case 'push.sent': return has('sent', 'users') ? t('admin.engagement.sum.push', { source: String(d.source ?? ''), sent: n('sent'), users: n('users') }) : e.msg;
    default: return e.msg;
  }
}
