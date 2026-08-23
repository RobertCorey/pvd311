import { useCallback, useEffect, useState } from 'react';
import { useT } from '../i18n';
import { adminAct, adminReports, type AdminAction, type AdminReport } from '../api/admin';
import { ApiError } from '../api/types';
import CategoryIcon from '../components/CategoryIcon';
import { ALL_CATEGORIES } from '../lib/categories';
import AdminDetail from './AdminDetail';
import { When } from './adminUtil';

const STATUSES = ['', 'pending', 'awaiting_review', 'processing', 'submitted', 'failed', 'rejected', 'auto-rejected'];

/**
 * Reports tab — every report ever, newest first, server-filtered (status, category, q) with cursor paging.
 * Same detail pane as the Queue. `initialQuery` comes from deep links like #reports?q=<email>.
 */
export default function AdminReports({ initialQuery = '', initialStatus = '', say }: { initialQuery?: string; initialStatus?: string; say: (msg: string) => void }) {
  const t = useT();
  const [status, setStatus] = useState(initialStatus);
  const [category, setCategory] = useState('');
  const [q, setQ] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery); // debounced copy that hits the server
  const [items, setItems] = useState<AdminReport[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => { const id = window.setTimeout(() => setQuery(q.trim()), 300); return () => window.clearTimeout(id); }, [q]);
  useEffect(() => { setQ(initialQuery); setQuery(initialQuery); }, [initialQuery]);
  useEffect(() => { setStatus(initialStatus); }, [initialStatus]);

  const load = useCallback(async (before: string | null = null) => {
    setLoading(true);
    try {
      const r = await adminReports({ status, category, q: query, before, limit: 50 });
      setItems((prev) => (before && prev ? [...prev, ...r.items] : r.items));
      setNext(r.next); setErr(false);
    } catch { setErr(true); } finally { setLoading(false); }
  }, [status, category, query]);
  useEffect(() => { setSelected(null); void load(); }, [load]);

  const current = items?.find((r) => r.id === selected) ?? null;
  async function act(r: AdminReport, action: AdminAction, reason?: string) {
    setBusy(r.id);
    try { const after = await adminAct(r.id, action, reason ? { reason } : {}); setItems((l) => l && l.map((x) => (x.id === after.id ? after : x))); say(t(`admin.done.${action}`)); }
    catch (e) { say(e instanceof ApiError && e.status === 409 ? t('admin.conflict', { status: e.code }) : t('admin.error')); void load(); }
    finally { setBusy(null); }
  }

  return (
    <div className={`admin-queue${current ? ' has-pane' : ''}`}>
      <div className="admin-table-wrap">
        <div className="admin-filters">
          <label className="admin-filter"><span className="label">{t('admin.col.status')}</span>
            <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>{STATUSES.map((s) => <option key={s} value={s}>{s ? t(`admin.status.${s}`) : t('admin.reports.any')}</option>)}</select></label>
          <label className="admin-filter"><span className="label">{t('admin.col.category')}</span>
            <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}><option value="">{t('admin.reports.any')}</option>{ALL_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></label>
          <label className="admin-filter admin-filter--grow"><span className="label">{t('admin.search')}</span>
            <input className="input" type="search" value={q} placeholder={t('admin.reports.qPlaceholder')} onChange={(e) => setQ(e.target.value)} /></label>
          <span className="admin-meta">{items ? t('admin.reports.loaded', { n: items.length }) : ''}</span>
          <button type="button" className="btn btn-ghost admin-refresh" onClick={() => load()} disabled={loading}>{t('admin.refresh')}</button>
        </div>
        {err && <div className="notice notice-error" role="alert">{t('admin.loadError')}</div>}
        {items == null ? <p className="muted" aria-busy="true">{t('account.loading')}</p> : items.length === 0 ? <p className="admin-empty">{t('admin.bucket.empty')}</p> : (
          <table className="admin-table">
            <thead><tr>
              <th scope="col">{t('admin.col.age')}</th><th scope="col">{t('admin.col.category')}</th><th scope="col">{t('admin.col.address')}</th><th scope="col">{t('admin.col.reporter')}</th>
              <th scope="col">{t('admin.col.status')}</th><th scope="col" className="admin-col-opt">{t('admin.col.case')}</th><th scope="col" className="admin-col-opt">{t('admin.col.cityStatus')}</th><th scope="col" className="admin-col-opt">{t('admin.col.flags')}</th>
            </tr></thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} className={r.id === selected ? 'is-selected' : ''} aria-selected={r.id === selected} tabIndex={0} onClick={() => setSelected(r.id)} onKeyDown={(e) => { if (e.key === 'Enter') setSelected(r.id); }}>
                  <td className="admin-td-age"><When iso={r.createdAt} t={t} compact /></td>
                  <td className="admin-td-cat"><CategoryIcon k={r.category} size={16} /> {r.categoryLabel}</td>
                  <td className="admin-td-addr">{r.address}</td>
                  <td className="admin-td-rep">{r.reporterEmail ?? <span className="admin-meta">{t('admin.noEmail')}</span>}</td>
                  <td className="admin-td-status"><span className="admin-status">{t(`admin.status.${r.status}`)}</span>{r.statusDetail && <div className="admin-meta" title={r.statusDetail}>{r.statusDetail}</div>}</td>
                  <td className="admin-td-case admin-col-opt">{r.portalCaseId ?? <span className="admin-meta">—</span>}</td>
                  <td className="admin-col-opt">{r.portalStatus ?? <span className="admin-meta">—</span>}</td>
                  <td className="admin-td-flags admin-col-opt">{r.intakeFlags.map((f) => <span key={f} className="admin-flag">{f}</span>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {next && <button type="button" className="btn btn-ghost" disabled={loading} onClick={() => load(next)}>{t('admin.sys.more')}</button>}
      </div>
      {current && <AdminDetail key={current.id} r={current} busy={busy === current.id} onAct={(a, reason) => act(current, a, reason)} onClose={() => setSelected(null)} />}
    </div>
  );
}
