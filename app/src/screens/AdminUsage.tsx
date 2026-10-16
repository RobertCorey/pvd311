import { useCallback, useEffect, useState } from 'react';
import { useT } from '../i18n';
import { adminUsage, type AdminUsage as Usage } from '../api/admin';
import { shortLabel } from '../lib/categories';

const RANGES = [1, 7, 30] as const;
const FUNNEL = ['page_view', 'select_category', 'photo_added', 'sign_in_gate_shown', 'sign_in_link_sent', 'login', 'report_submitted'];

/**
 * Usage tab — first-party analytics (POST /api/ui → Analytics Engine), so visitors with ad blockers count too.
 * Funnel = distinct visitors who did each step in the range (not strictly in order). Days are UTC.
 */
export default function AdminUsage() {
  const t = useT();
  const [days, setDays] = useState<number>(7);
  const [u, setU] = useState<Usage | null>(null);
  const [err, setErr] = useState(false);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try { setU(await adminUsage(days)); setErr(false); } catch { setErr(true); } finally { setLoading(false); }
  }, [days]);
  useEffect(() => { void load(); }, [load]);

  const top = u?.funnel.find((f) => f.event === 'page_view')?.visitors ?? 0;
  const pct = (n: number) => (top ? `${Math.round((n / top) * 100)}%` : '—');
  const maxDay = Math.max(1, ...(u?.daily.map((d) => d.visitors) ?? [1]));

  return (
    <div className="admin-usage">
      <div className="admin-filters">
        <div className="usage-range" role="group" aria-label={t('admin.usage.range')}>
          {RANGES.map((d) => <button key={d} type="button" className={`btn btn-ghost admin-tbl-btn${d === days ? ' is-on' : ''}`} aria-pressed={d === days} onClick={() => setDays(d)}>{t('admin.usage.days', { n: d })}</button>)}
        </div>
        <button type="button" className="btn btn-ghost admin-refresh" onClick={load} disabled={loading}>{t('admin.refresh')}</button>
      </div>
      <p className="admin-meta">{t('admin.usage.what')}</p>
      {err && <div className="notice notice-error" role="alert">{t('admin.loadError')}</div>}
      {!u ? (!err && <p className="muted" aria-busy="true">{t('account.loading')}</p>) : !u.configured ? <p className="admin-empty">{t('admin.usage.notConfigured')}</p> : (
        <>
          <div className="sys-numbers">
            <div className="card sys-num"><b>{u.totals.visitors}</b><span>{t('admin.usage.visitors')}</span></div>
            <div className="card sys-num"><b>{u.totals.sessions}</b><span>{t('admin.usage.sessions')}</span></div>
            <div className="card sys-num"><b>{u.totals.pageViews}</b><span>{t('admin.usage.pageViews')}</span></div>
            <div className="card sys-num"><b>{u.funnel.find((f) => f.event === 'report_submitted')?.count ?? 0}</b><span>{t('admin.usage.reports')}</span></div>
          </div>

          <section className="admin-section">
            <h2>{t('admin.usage.funnel')}</h2>
            <table className="admin-table usage-table">
              <thead><tr><th scope="col">{t('admin.usage.step')}</th><th scope="col">{t('admin.usage.visitors')}</th><th scope="col">{t('admin.usage.ofVisitors')}</th><th scope="col"><span className="visually-hidden">{t('admin.usage.bar')}</span></th></tr></thead>
              <tbody>
                {FUNNEL.map((e) => { const f = u.funnel.find((x) => x.event === e); const n = f?.visitors ?? 0; return (
                  <tr key={e}><td>{t(`admin.usage.ev.${e}`)}</td><td>{n}</td><td>{pct(n)}</td><td className="usage-bar-cell"><span className="usage-bar" style={{ width: top ? `${(n / top) * 100}%` : 0 }} /></td></tr>
                ); })}
              </tbody>
            </table>
            <p className="admin-meta">{t('admin.usage.side', { errors: u.funnel.find((f) => f.event === 'report_error')?.count ?? 0, shares: u.funnel.find((f) => f.event === 'share')?.count ?? 0 })}</p>
          </section>

          <section className="admin-section">
            <h2>{t('admin.usage.daily')}</h2>
            {u.daily.length === 0 ? <p className="admin-empty">{t('admin.bucket.empty')}</p> : (
              <table className="admin-table usage-table">
                <thead><tr><th scope="col">{t('admin.usage.day')}</th><th scope="col">{t('admin.usage.visitors')}</th><th scope="col">{t('admin.usage.reports')}</th><th scope="col"><span className="visually-hidden">{t('admin.usage.bar')}</span></th></tr></thead>
                <tbody>{u.daily.map((d) => <tr key={d.day}><td>{d.day}</td><td>{d.visitors}</td><td>{d.reports}</td><td className="usage-bar-cell"><span className="usage-bar" style={{ width: `${(d.visitors / maxDay) * 100}%` }} /></td></tr>)}</tbody>
              </table>
            )}
          </section>

          <div className="usage-grid">
            <Top title={t('admin.usage.sources')} rows={u.sources.map((r) => [r.source, r.visitors])} />
            <Top title={t('admin.usage.pages')} rows={u.pages.map((r) => [r.path, r.views])} />
            <Top title={t('admin.usage.devices')} rows={u.devices.map((r) => [r.device, r.visitors])} />
            <Top title={t('admin.usage.countries')} rows={u.countries.map((r) => [r.country, r.visitors])} />
            <Top title={t('admin.usage.categories')} rows={u.categories.map((r) => [shortLabel(r.category, t), r.visitors])} />
          </div>
        </>
      )}
    </div>
  );
}

function Top({ title, rows }: { title: string; rows: [string, number][] }) {
  const t = useT();
  return (
    <section className="admin-section">
      <h2>{title}</h2>
      {rows.length === 0 ? <p className="admin-empty">{t('admin.bucket.empty')}</p> : (
        <table className="admin-table usage-table"><tbody>{rows.map(([k, n]) => <tr key={k}><td>{k}</td><td>{n}</td></tr>)}</tbody></table>
      )}
    </section>
  );
}
