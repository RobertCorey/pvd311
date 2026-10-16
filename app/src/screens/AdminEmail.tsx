import { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from '../i18n';
import { adminEmailSync, adminEmails, type AdminEmailRow } from '../api/admin';
import { When, abs } from './adminUtil';
import { AdminEmailPane, DeliveryPill, KIND_GROUPS, KindChip, counterpart } from './AdminEmailParts';
import './AdminEmail.css';

const PAGE = 100;

/**
 * /admin → Email: every email in and out (worker/src/emaillog.ts), newest first. Filter by direction, kind and text;
 * a row opens the mail on the right (`#email:<id>` deep-links one). Each mail links to its report and to the people on
 * it, so the same system reads by email here, by report in the Reports pane, and by person in Accounts.
 */
export default function AdminEmail({ openId, go }: { openId: string | null; go: (hash: string) => void }) {
  const t = useT();
  const [items, setItems] = useState<AdminEmailRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(false);
  const [dir, setDir] = useState<'' | 'in' | 'out'>('');
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async (before: string | null) => {
    setLoading(true); setErr(false);
    try {
      const page = await adminEmails({ dir, kind, q: q.trim(), before, limit: PAGE });
      setItems((prev) => (before ? [...prev, ...page.items] : page.items));
      setNext(page.next);
      setLoaded(true);
    } catch { setErr(true); } finally { setLoading(false); }
  }, [dir, kind, q]);
  useEffect(() => { const h = window.setTimeout(() => void load(null), q ? 250 : 0); return () => window.clearTimeout(h); }, [load, q]);

  const counts = useMemo(() => ({ in: items.filter((e) => e.dir === 'in').length, out: items.filter((e) => e.dir === 'out').length, trouble: items.filter((e) => e.status === 'failed' || ['bounced', 'complained', 'failed'].includes(e.lastEvent ?? '')).length }), [items]);

  async function sync() {
    setSyncing(true); setSyncMsg(null);
    try {
      const r = await adminEmailSync();
      setSyncMsg(r.unreadable ? t('admin.email.syncSendOnly', { city: r.cityImported }) : t('admin.email.synced', { n: r.imported, city: r.cityImported, updated: r.updated }));
      void load(null);
    } catch { setSyncMsg(t('admin.error')); } finally { setSyncing(false); }
  }

  const close = () => go('#email');
  return (
    <div className={`admin-queue admin-email${openId ? ' has-pane' : ''}`}>
      <div className="admin-table-wrap">
        <p className="portal-intro">{t('admin.email.intro')}</p>
        <div className="admin-filters">
          <div className="admin-filter email-dir-filter">
            <span className="label" id="email-dir-l">{t('admin.email.direction')}</span>
            <div className="usage-range" role="group" aria-labelledby="email-dir-l">
              {(['', 'out', 'in'] as const).map((d) => (
                <button key={d || 'all'} type="button" className={`btn btn-ghost admin-tbl-btn${dir === d ? ' is-on' : ''}`} aria-pressed={dir === d} onClick={() => setDir(d)}>
                  {d ? t(`admin.email.dir.${d}`) : t('admin.email.dir.all')}
                </button>
              ))}
            </div>
          </div>
          <label className="admin-filter">
            <span className="label">{t('admin.email.kind')}</span>
            <select className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">{t('admin.email.kind.any')}</option>
              {KIND_GROUPS.map((g) => (
                <optgroup key={g.key} label={t(`admin.email.group.${g.key}`)}>
                  {g.kinds.map((k) => <option key={k} value={k}>{t(`admin.email.kind.${k}`)}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
          <label className="admin-filter admin-filter--grow">
            <span className="label">{t('admin.email.search')}</span>
            <input className="input" type="search" placeholder={t('admin.email.searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <button type="button" className="btn btn-ghost admin-refresh" onClick={() => load(null)} disabled={loading}>{t('admin.refresh')}</button>
          <button type="button" className="btn btn-ghost admin-refresh" onClick={sync} disabled={syncing} title={t('admin.email.syncHint')}>{syncing ? t('admin.email.syncing') : t('admin.email.sync')}</button>
        </div>
        {syncMsg && <p className="admin-meta" role="status">{syncMsg}</p>}
        {err && <div className="notice notice-error" role="alert">{t('admin.loadError')} <button type="button" className="btn btn-ghost" onClick={() => load(null)}>{t('account.retry')}</button></div>}
        {!loaded ? <p className="muted" aria-busy="true">{t('account.loading')}</p> : (
          <>
            <p className="admin-meta email-totals">{t('admin.email.totals', { n: items.length, out: counts.out, in: counts.in })}{counts.trouble > 0 && <> · <strong className="email-trouble">{t('admin.email.trouble', { n: counts.trouble })}</strong></>}</p>
            {items.length === 0 ? <p className="admin-empty">{t('admin.email.empty')}</p> : (
              <table className="admin-table admin-table--rows email-table">
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
                  {items.map((e) => (
                    <tr key={e.id} className={e.id === openId ? 'is-selected' : ''} aria-selected={e.id === openId} tabIndex={0}
                      onClick={() => go(`#email:${encodeURIComponent(e.id)}`)} onKeyDown={(ev) => { if (ev.key === 'Enter') go(`#email:${encodeURIComponent(e.id)}`); }}>
                      <td className="admin-td-age email-td-when" title={abs(e.at)}><span className={`email-dir email-dir--${e.dir}`} aria-label={t(`admin.email.dir.${e.dir}`)}>{e.dir === 'in' ? '↓' : '↑'}</span> <When iso={e.at} t={t} compact /></td>
                      <td className="admin-td-cat email-td-kind"><KindChip kind={e.kind} t={t} /></td>
                      <td className="admin-td-rep email-td-who">{counterpart(e)}</td>
                      <td className="admin-td-addr email-td-subject">{e.subject || t('admin.email.noSubject')}{e.caseId && <span className="admin-meta"> · {e.caseId}</span>}</td>
                      <td className="admin-td-status email-td-delivery"><DeliveryPill e={e} t={t} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {next && <div className="acct-more"><button type="button" className="btn btn-secondary" disabled={loading} onClick={() => load(next)}>{t('admin.accounts.loadMore')}</button></div>}
          </>
        )}
      </div>
      {openId && <AdminEmailPane key={openId} id={openId} onClose={close} />}
    </div>
  );
}
