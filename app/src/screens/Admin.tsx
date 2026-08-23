import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useT } from '../i18n';
import { useSession } from '../lib/auth';
import { getMe } from '../api/me';
import { adminAct, adminEngine, adminOverview, type AdminAction, type AdminOverview, type AdminReport } from '../api/admin';
import { ApiError } from '../api/types';
import GoogleSignInButton from '../components/GoogleSignInButton';
import CategoryIcon from '../components/CategoryIcon';
import AdminSystem from './AdminSystem';
import AdminDetail from './AdminDetail';
import { When } from './adminUtil';
import './Admin.css';

type Gate = 'checking' | 'signedOut' | 'notAdmin' | 'admin';
type Tab = 'queue' | 'system';
export type Bucket = 'awaitingReview' | 'failed' | 'pending' | 'submitted7d';
const BUCKETS: Bucket[] = ['awaitingReview', 'failed', 'pending', 'submitted7d'];
export const ACTIONS: Record<string, AdminAction[]> = { awaiting_review: ['approve', 'reject'], failed: ['requeue', 'reject'], pending: ['reject'] };

/**
 * /admin — desktop-first ops console (14" MacBook: 1512×982). Left rail (tabs, search, engine, identity) + content.
 * Queue = sortable table with section pills and a right-hand detail pane; System = dashboard grid (AdminSystem).
 * The Worker enforces admin on every call; this screen only routes on /api/me `admin`.
 * Keyboard on the queue: j/k move, Enter/o open, a approve, r reject, Esc close, / search.
 */
export default function Admin() {
  const t = useT();
  const session = useSession();
  const [adminFlag, setAdminFlag] = useState<boolean | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const gate: Gate = !session ? 'signedOut' : adminFlag == null ? 'checking' : adminFlag ? 'admin' : 'notAdmin';
  const [tab, setTab] = useState<Tab>(() => (location.hash === '#system' ? 'system' : 'queue'));
  const [data, setData] = useState<AdminOverview | null>(null);
  const [err, setErr] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [bucket, setBucket] = useState<Bucket>('awaitingReview');
  const [sort, setSort] = useState<'newest' | 'oldest'>('oldest');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Desktop shell: hide the phone chrome (tab bar, footer) and widen main while this route is mounted.
  useEffect(() => { document.body.classList.add('is-admin'); return () => document.body.classList.remove('is-admin'); }, []);

  const say = useCallback((msg: string) => { setToast(msg); window.setTimeout(() => setToast(null), 3500); }, []);
  const load = useCallback(async () => { try { setData(await adminOverview()); setErr(false); } catch { setErr(true); } }, []);

  useEffect(() => {
    if (!session) return;
    let live = true;
    getMe().then((m) => { if (live) { setAdminFlag(m.admin === true); setEmail(m.email); } }).catch(() => { if (live) setAdminFlag(false); });
    return () => { live = false; setAdminFlag(null); setData(null); };
  }, [session]);
  useEffect(() => {
    if (gate !== 'admin') return;
    void load();
    const tick = () => { if (document.visibilityState === 'visible') void load(); };
    const iv = window.setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(iv); document.removeEventListener('visibilitychange', tick); };
  }, [gate, load]);

  // Rows for the current section: search across all buckets when a query is typed, else the selected bucket.
  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    const src = q ? BUCKETS.flatMap((b) => data[b]) : data[bucket];
    const hit = (r: AdminReport) => !q || [r.id, r.address, r.categoryLabel, r.reporterEmail, r.portalCaseId, r.description, r.statusDetail].some((v) => v?.toLowerCase().includes(q));
    const ts = (r: AdminReport) => Date.parse(r.createdAt ?? '') || 0;
    return src.filter(hit).sort((a, b) => (sort === 'oldest' ? ts(a) - ts(b) : ts(b) - ts(a)));
  }, [data, bucket, sort, query]);
  const current = rows.find((r) => r.id === selected) ?? null;

  const act = useCallback(async (r: AdminReport, action: AdminAction, reason?: string) => {
    setBusy(r.id);
    try {
      const after = await adminAct(r.id, action, reason ? { reason } : {});
      setData((d) => d && rebucket(d, after));
      say(t(`admin.done.${action}`));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { say(t('admin.conflict', { status: e.code })); void load(); }
      else say(t('admin.error'));
    } finally { setBusy(null); }
  }, [load, say, t]);
  async function engine(op: 'pause' | 'resume') {
    setBusy('engine');
    try { const r = await adminEngine(op); setData((d) => d && { ...d, engine: { ...d.engine, paused: r.paused, consecutiveFailures: op === 'resume' ? 0 : d.engine.consecutiveFailures } }); say(t(op === 'pause' ? 'admin.engine.pausedToast' : 'admin.engine.resumed')); }
    catch { say(t('admin.error')); } finally { setBusy(null); }
  }

  // Keyboard: j/k move the selection, Enter/o open, a approve, r reject (focuses the pane's reason box), Esc close, / search.
  useEffect(() => {
    if (gate !== 'admin' || tab !== 'queue') return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) { if (e.key === 'Escape') el.blur(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const i = rows.findIndex((r) => r.id === selected);
      if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); setSelected(rows[Math.min(rows.length - 1, i + 1)]?.id ?? null); }
      else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); setSelected(rows[Math.max(0, i - 1)]?.id ?? rows[0]?.id ?? null); }
      else if (e.key === 'Escape') setSelected(null);
      else if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); }
      else if (e.key === 'a' && current && ACTIONS[current.status]?.includes('approve')) void act(current, 'approve');
      else if (e.key === 'r' && current && ACTIONS[current.status]?.includes('reject')) document.dispatchEvent(new CustomEvent('admin:reject'));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [gate, tab, rows, selected, current, act]);

  if (gate === 'signedOut') {
    return (
      <section className="section admin admin-gate">
        <h1 className="admin-h1">{t('admin.title')}</h1>
        <p className="muted">{t('admin.signIn')}</p>
        <GoogleSignInButton className="account-google" label={t('account.google')} width={280} />
      </section>
    );
  }
  if (gate === 'checking') return <section className="section admin admin-gate"><p className="muted" aria-busy="true">{t('account.loading')}</p></section>;
  if (gate === 'notAdmin') return <section className="section admin admin-gate"><h1 className="admin-h1">{t('admin.title')}</h1><p className="muted">{t('admin.notAdmin')}</p></section>;

  const switchTab = (k: Tab) => { setTab(k); history.replaceState(null, '', k === 'system' ? '#system' : '#'); };
  return (
    <div className="admin admin-shell">
      <aside className="admin-rail" aria-label={t('admin.title')}>
        <div className="admin-rail-title">{t('admin.title')}</div>
        <nav className="admin-rail-nav" role="tablist" aria-label={t('admin.title')}>
          {(['queue', 'system'] as const).map((k) => (
            <button key={k} type="button" role="tab" className="admin-rail-tab" aria-selected={tab === k} onClick={() => switchTab(k)}>
              {t(`admin.tab.${k}`)}
              {k === 'queue' && data && data.awaitingReview.length > 0 && <span className="admin-badge">{data.awaitingReview.length}</span>}
            </button>
          ))}
        </nav>
        <label className="admin-rail-search">
          <span className="visually-hidden">{t('admin.search')}</span>
          <input ref={searchRef} className="input" type="search" placeholder={t('admin.searchPlaceholder')} value={query}
            onChange={(e) => { setQuery(e.target.value); if (tab !== 'queue') switchTab('queue'); }} />
        </label>
        {data && (
          <div className={`admin-rail-engine${data.engine.paused ? ' is-paused' : ''}`}>
            <div className="admin-rail-engine-row"><span className={`sys-dot sys-dot--${data.engine.paused ? 'error' : 'ok'}`} aria-hidden="true" /><strong>{data.engine.paused ? t('admin.engine.paused') : t('admin.engine.running')}</strong></div>
            <div className="admin-meta">{t('admin.engine.hour', { n: data.engine.submissionsThisHour })} · {t('admin.engine.failures', { n: data.engine.consecutiveFailures })}</div>
            <div className="admin-meta">{t('admin.engine.mode', { mode: data.engine.hitlMode, n: data.engine.accountTrustN })}</div>
            {data.engine.paused
              ? <button type="button" className="btn btn-primary admin-rail-btn" disabled={busy === 'engine'} onClick={() => engine('resume')}>{t('admin.engine.resume')}</button>
              : <button type="button" className="btn btn-ghost admin-rail-btn" disabled={busy === 'engine'} onClick={() => engine('pause')}>{t('admin.engine.pause')}</button>}
          </div>
        )}
        <div className="admin-rail-foot">
          <span className="admin-meta admin-ellipsis" title={email ?? ''}>{email}</span>
          <Link to="/account" className="admin-meta">{t('header.accountIn')}</Link>
          <span className="admin-meta admin-keys" title={t('admin.keys.help')}>{t('admin.keys')}</span>
        </div>
      </aside>

      <section className="admin-main" aria-label={t(`admin.tab.${tab}`)}>
        {tab === 'system' ? <AdminSystem /> : (
          <>
            {err && <div className="notice notice-error" role="alert">{t('admin.loadError')} <button type="button" className="btn btn-ghost" onClick={load}>{t('account.retry')}</button></div>}
            {!data ? <p className="muted" aria-busy="true">{t('account.loading')}</p> : (
              <div className={`admin-queue${current ? ' has-pane' : ''}`}>
                <div className="admin-table-wrap">
                  <div className="admin-pills" role="group" aria-label={t('admin.sections')}>
                    {BUCKETS.map((b) => (
                      <button key={b} type="button" className="chip admin-pill" aria-pressed={!query && bucket === b} onClick={() => { setQuery(''); setBucket(b); setSelected(null); }}>
                        {t(`admin.bucket.${b}`)} <span className="admin-count">{data[b].length}</span>
                      </button>
                    ))}
                    {query && <span className="admin-meta">{t('admin.searchResults', { n: rows.length })}</span>}
                    <button type="button" className="btn btn-ghost admin-refresh" onClick={load}>{t('admin.refresh')}</button>
                  </div>
                  {rows.length === 0 ? <p className="admin-empty">{t('admin.bucket.empty')}</p> : (
                    <table className="admin-table">
                      <thead>
                        <tr>
                          <th scope="col" aria-sort={sort === 'oldest' ? 'ascending' : 'descending'}><button type="button" className="admin-sort" onClick={() => setSort((s) => (s === 'oldest' ? 'newest' : 'oldest'))}>{t('admin.col.age')} {sort === 'oldest' ? '↑' : '↓'}</button></th>
                          <th scope="col">{t('admin.col.category')}</th>
                          <th scope="col">{t('admin.col.address')}</th>
                          <th scope="col">{t('admin.col.reporter')}</th>
                          <th scope="col">{t('admin.col.flags')}</th>
                          <th scope="col">{t('admin.col.status')}</th>
                          <th scope="col"><span className="visually-hidden">{t('admin.col.actions')}</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr key={r.id} className={r.id === selected ? 'is-selected' : ''} aria-selected={r.id === selected} tabIndex={0}
                            onClick={() => setSelected(r.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'o') setSelected(r.id); }}>
                            <td className="admin-td-age"><When iso={r.createdAt} t={t} compact /></td>
                            <td className="admin-td-cat"><CategoryIcon k={r.category} size={16} /> {r.categoryLabel}</td>
                            <td className="admin-td-addr">{r.address}{r.portalCaseId ? <span className="admin-meta"> · {r.portalCaseId}</span> : null}</td>
                            <td className="admin-td-rep">{r.reporterEmail ?? <span className="admin-meta">{t('admin.noEmail')}</span>}</td>
                            <td className="admin-td-flags">{r.intakeFlags.map((f) => <span key={f} className="admin-flag">{f}</span>)}</td>
                            <td className="admin-td-status"><span className="admin-status">{t(`admin.status.${r.status}`)}</span>{r.portalStatus && <span className="admin-meta"> · {r.portalStatus}</span>}{r.statusDetail && <div className="admin-meta admin-ellipsis" title={r.statusDetail}>{r.statusDetail}</div>}</td>
                            <td className="admin-td-actions" onClick={(e) => e.stopPropagation()}>
                              {(ACTIONS[r.status] ?? []).filter((a) => a !== 'reject').map((a) => (
                                <button key={a} type="button" className="btn btn-ghost admin-tbl-btn" disabled={busy === r.id} onClick={() => act(r, a)}>{t(`admin.action.${a}`)}</button>
                              ))}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
                {current && <AdminDetail key={current.id} r={current} busy={busy === current.id} onAct={(a, reason) => act(current, a, reason)} onClose={() => setSelected(null)} />}
              </div>
            )}
          </>
        )}
        {toast && <div className="notice notice-ok admin-toast" role="status">{toast}</div>}
      </section>
    </div>
  );
}

/** Move a report into the bucket its new status belongs to (or drop it). */
function rebucket(d: AdminOverview, after: AdminReport): AdminOverview {
  const strip = (list: AdminReport[]) => list.filter((x) => x.id !== after.id);
  const next: AdminOverview = { engine: d.engine, awaitingReview: strip(d.awaitingReview), failed: strip(d.failed), pending: strip(d.pending), submitted7d: strip(d.submitted7d) };
  const target: Bucket | null = after.status === 'awaiting_review' ? 'awaitingReview' : after.status === 'failed' ? 'failed' : after.status === 'pending' ? 'pending' : after.status === 'submitted' ? 'submitted7d' : null;
  if (target) next[target] = [after, ...next[target]];
  return next;
}
