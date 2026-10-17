import { useCallback, useEffect, useState } from 'react';
import { useT } from '../i18n';
import { adminCityCases, type AdminCityCase } from '../api/admin';
import CategoryIcon from '../components/CategoryIcon';
import { ALL_CATEGORIES } from '../lib/categories';
import { When, abs } from './adminUtil';
import AdminCityInsights from './AdminCityInsights';

const STATUSES = ['', 'Draft', 'Submitted', 'Assigned', 'In Progress', 'Department Responded', 'Resolved', 'Cancelled'];

/**
 * City cases tab — every case on the city's public feed, anyone's (worker citycases.ts), newest first.
 * Row → side pane with what the city's public detail form shows: address, dates, resolution message, answers.
 * "How it gets done" view: AdminCityInsights (a case type there opens this list searched for it).
 */
export default function AdminCityCases() {
  const t = useT();
  const [view, setView] = useState<'list' | 'insights'>('list');
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<AdminCityCase[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ syncedAt: string | null; tracked: number } | null>(null);
  const [err, setErr] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => { const id = window.setTimeout(() => setQuery(q.trim()), 300); return () => window.clearTimeout(id); }, [q]);
  const load = useCallback(async (before: string | null = null) => {
    setLoading(true);
    try {
      const r = await adminCityCases({ status, category, q: query, before, limit: 50 });
      setItems((prev) => (before && prev ? [...prev, ...r.items] : r.items));
      setNext(r.next); setMeta({ syncedAt: r.syncedAt, tracked: r.tracked }); setErr(false);
    } catch { setErr(true); } finally { setLoading(false); }
  }, [status, category, query]);
  useEffect(() => { setSelected(null); void load(); }, [load]);

  const current = items?.find((c) => c.id === selected) ?? null;
  const views = (
    <div className="cc-views" role="group" aria-label={t('admin.cc.views')}>
      <button type="button" className="btn btn-ghost" aria-pressed={view === 'list'} onClick={() => setView('list')}>{t('admin.cc.viewList')}</button>
      <button type="button" className="btn btn-ghost" aria-pressed={view === 'insights'} onClick={() => setView('insights')}>{t('admin.cc.viewInsights')}</button>
    </div>
  );
  if (view === 'insights') return <div>{views}<AdminCityInsights onType={(ty) => { setQ(ty); setQuery(ty); setStatus(''); setCategory(''); setView('list'); }} /></div>;
  return (
    <div className={`admin-queue${current ? ' has-pane' : ''}`}>
      <div className="admin-table-wrap">
        {views}
        <div className="admin-filters">
          <label className="admin-filter"><span className="label">{t('admin.col.status')}</span>
            <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>{STATUSES.map((s) => <option key={s} value={s}>{s || t('admin.reports.any')}</option>)}</select></label>
          <label className="admin-filter"><span className="label">{t('admin.col.category')}</span>
            <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}><option value="">{t('admin.reports.any')}</option>{ALL_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></label>
          <label className="admin-filter admin-filter--grow"><span className="label">{t('admin.search')}</span>
            <input className="input" type="search" value={q} placeholder={t('admin.cc.qPlaceholder')} onChange={(e) => setQ(e.target.value)} /></label>
          <span className="admin-meta">{meta ? t('admin.cc.synced', { n: meta.tracked, when: meta.syncedAt ? abs(meta.syncedAt) : '—' }) : ''}</span>
          <button type="button" className="btn btn-ghost admin-refresh" onClick={() => load()} disabled={loading}>{t('admin.refresh')}</button>
        </div>
        {err && <div className="notice notice-error" role="alert">{t('admin.loadError')}</div>}
        {items == null ? <p className="muted" aria-busy="true">{t('account.loading')}</p> : items.length === 0 ? <p className="admin-empty">{t('admin.bucket.empty')}</p> : (
          <table className="admin-table admin-table--rows">
            <thead><tr>
              <th scope="col">{t('admin.col.age')}</th><th scope="col">{t('admin.cc.type')}</th><th scope="col">{t('admin.col.address')}</th>
              <th scope="col">{t('admin.col.status')}</th><th scope="col" className="admin-col-opt">{t('admin.cc.resolution')}</th>
            </tr></thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id} className={c.id === selected ? 'is-selected' : ''} aria-selected={c.id === selected} tabIndex={0} onClick={() => setSelected(c.id)} onKeyDown={(e) => { if (e.key === 'Enter') setSelected(c.id); }}>
                  <td className="admin-td-age"><When iso={c.createdAt} t={t} compact /></td>
                  <td className="admin-td-cat"><CategoryIcon k={c.category} size={16} /> {c.caseType}</td>
                  <td className="admin-td-addr">{c.detail?.address ?? (c.street || <span className="admin-meta">—</span>)}</td>
                  <td className="admin-td-status"><span className="admin-status">{c.status}</span></td>
                  <td className="admin-col-opt">{c.detail?.resolution ?? <span className="admin-meta">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {next && <button type="button" className="btn btn-ghost" disabled={loading} onClick={() => load(next)}>{t('admin.sys.more')}</button>}
      </div>
      {current && <CityCasePane key={current.id} c={current} onClose={() => setSelected(null)} />}
    </div>
  );
}

function CityCasePane({ c, onClose }: { c: AdminCityCase; onClose: () => void }) {
  const t = useT();
  const d = c.detail;
  const date = (k: string, iso: string | null | undefined) => iso ? <><dt>{t(k)}</dt><dd>{abs(iso)}</dd></> : null;
  const seen = Object.entries(c.statusSeen ?? {}).sort(([, a], [, b]) => a.localeCompare(b));
  return (
    <aside className="admin-pane" aria-label={t('admin.cc.pane')}>
      <div className="admin-pane-head">
        <span className="admin-pane-cat"><CategoryIcon k={c.category} size={20} /> <strong>{c.caseType}</strong></span>
        <span className="admin-status">{c.status}</span>
        <button type="button" className="btn btn-ghost admin-pane-close" onClick={onClose} aria-label={t('admin.pane.close')}>✕</button>
      </div>
      <div className="admin-pane-body">
        <dl className="admin-dl">
          <dt>{t('admin.col.address')}</dt><dd>{d?.address ?? (c.street || '—')}</dd>
          <dt>{t('admin.cc.created')}</dt><dd><When iso={c.createdAt} t={t} /> <span className="admin-meta">{abs(c.createdAt)}</span></dd>
          {date('admin.cc.received', d?.receivedOn)}
          {date('admin.cc.routed', d?.routedOn)}
          {date('admin.cc.workCompleted', d?.workCompletedOn)}
          {date('admin.cc.resolved', d?.resolutionDate)}
          {d?.resolution && <><dt>{t('admin.cc.resolution')}</dt><dd>{d.resolution}</dd></>}
          {seen.length > 0 && <><dt>{t('admin.cc.seen')}</dt><dd>{seen.map(([s, at]) => <div key={s}>{s.replace(/_/g, ' ')} <span className="admin-meta">{abs(at)}</span></div>)}</dd></>}
        </dl>
        {d && Object.keys(d.answers).length > 0 && (
          <dl className="admin-dl admin-dl--extra">{Object.entries(d.answers).map(([k, v]) => <div key={k}><dt>{d.labels?.[k] ?? k}</dt><dd>{v === true ? t('admin.cc.yes') : v}</dd></div>)}</dl>
        )}
        <p className="admin-meta">{d ? t('admin.cc.read', { when: abs(c.detailAt) }) : t('admin.cc.notRead')} · {c.id}</p>
      </div>
    </aside>
  );
}
