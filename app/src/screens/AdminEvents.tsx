import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useT } from '../i18n';
import { adminEvents, type AdminEvent } from '../api/admin';
import { Dot, When, abs } from './adminUtil';

const LEVELS = ['', 'info', 'warn', 'error'];
const KINDS = ['', 'report.created', 'hitl.requested', 'hitl.approved', 'hitl.rejected', 'submit.ok', 'submit.failed', 'tick.reaped', 'tick.auto_rejected', 'engine.breaker', 'watcher.status', 'canary.drift', 'retention.photo_deleted', 'auth.link_sent', 'intake.flagged', 'admin.pause', 'admin.resume', 'admin.trust'];

/** Events tab — the full 14-day stream with level / kind / report filters, cursor paging, and a raw `data` toggle per row. */
export default function AdminEvents({ initialReportId = '' }: { initialReportId?: string }) {
  const t = useT();
  const [level, setLevel] = useState('');
  const [kind, setKind] = useState('');
  const [reportId, setReportId] = useState(initialReportId);
  const [items, setItems] = useState<AdminEvent[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = useCallback(async (before: string | null = null) => {
    setLoading(true);
    try {
      const r = await adminEvents({ level, kind, reportId: reportId.trim(), before, limit: 100 });
      setItems((prev) => (before && prev ? [...prev, ...r.items] : r.items));
      setNext(r.next); setErr(false);
    } catch { setErr(true); } finally { setLoading(false); }
  }, [level, kind, reportId]);
  useEffect(() => { void load(); }, [load]);

  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="admin-events">
      <div className="admin-filters">
        <label className="admin-filter"><span className="label">{t('admin.sys.col.level')}</span>
          <select className="select" value={level} onChange={(e) => setLevel(e.target.value)}>{LEVELS.map((l) => <option key={l} value={l}>{l || t('admin.reports.any')}</option>)}</select></label>
        <label className="admin-filter"><span className="label">{t('admin.sys.col.kind')}</span>
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map((k) => <option key={k} value={k}>{k || t('admin.reports.any')}</option>)}</select></label>
        <label className="admin-filter admin-filter--grow"><span className="label">{t('admin.sys.col.report')}</span>
          <input className="input" value={reportId} placeholder={t('admin.events.reportPlaceholder')} onChange={(e) => setReportId(e.target.value)} /></label>
        <span className="admin-meta">{items ? t('admin.reports.loaded', { n: items.length }) : ''}</span>
        <button type="button" className="btn btn-ghost admin-refresh" onClick={() => load()} disabled={loading}>{t('admin.refresh')}</button>
      </div>
      <p className="admin-meta">{t('admin.events.what')} <a href="#explain:health">{t('admin.events.learn')}</a></p>
      {err && <div className="notice notice-error" role="alert">{t('admin.loadError')}</div>}
      {items == null ? <p className="muted" aria-busy="true">{t('account.loading')}</p> : items.length === 0 ? <p className="admin-empty">{t('admin.bucket.empty')}</p> : (
        <table className="admin-table sys-events-table">
          <thead><tr><th scope="col">{t('admin.sys.col.time')}</th><th scope="col">{t('admin.sys.col.level')}</th><th scope="col">{t('admin.sys.col.kind')}</th><th scope="col">{t('admin.sys.col.message')}</th><th scope="col">{t('admin.sys.col.report')}</th><th scope="col"><span className="visually-hidden">{t('admin.events.data')}</span></th></tr></thead>
          <tbody>
            {items.map((e) => (
              <EventRows key={e.id} e={e} open={open.has(e.id)} onToggle={() => toggle(e.id)} />
            ))}
          </tbody>
        </table>
      )}
      {next && <button type="button" className="btn btn-ghost" disabled={loading} onClick={() => load(next)}>{t('admin.sys.more')}</button>}
    </div>
  );
}

function EventRows({ e, open, onToggle }: { e: AdminEvent; open: boolean; onToggle: () => void }) {
  const t = useT();
  const hasData = !!e.data && Object.keys(e.data).length > 0;
  return (
    <>
      <tr className={`sys-event sys-event--${e.level}`}>
        <td className="sys-time"><When iso={e.at} t={t} /><div className="admin-meta">{abs(e.at)}</div></td>
        <td><Dot status={e.level === 'info' ? 'ok' : e.level} /> <span className="admin-meta">{e.level}</span></td>
        <td><span className="sys-kind">{e.kind}</span></td>
        <td className="sys-msg">{e.msg}<div className="admin-meta sys-kind-id">{e.id}</div></td>
        <td>{e.reportId && <><Link to={`/r/${e.reportId}`} target="_blank" className="sys-time" title={e.reportId}>{e.reportId.slice(0, 10)}…</Link> <a href={`#reports?q=${encodeURIComponent(e.reportId)}`} className="admin-meta">{t('admin.events.inReports')}</a></>}</td>
        <td>{hasData && <button type="button" className="btn btn-ghost admin-tbl-btn" aria-expanded={open} onClick={onToggle}>{open ? t('admin.raw.hide') : t('admin.raw.show')}</button>}</td>
      </tr>
      {open && hasData && <tr className="admin-raw-row"><td colSpan={6}><pre className="admin-raw">{JSON.stringify(e.data, null, 2)}</pre></td></tr>}
    </>
  );
}
