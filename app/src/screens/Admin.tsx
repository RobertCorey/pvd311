import { useCallback, useEffect, useState } from 'react';
import { useT } from '../i18n';
import { useSession } from '../lib/auth';
import { getMe } from '../api/me';
import { adminAct, adminEngine, adminOverview, type AdminAction, type AdminOverview, type AdminReport } from '../api/admin';
import { ApiError } from '../api/types';
import GoogleSignInButton from '../components/GoogleSignInButton';
import CategoryIcon from '../components/CategoryIcon';
import AdminSystem from './AdminSystem';
import './Admin.css';

type Gate = 'checking' | 'signedOut' | 'notAdmin' | 'admin';
type Bucket = 'awaitingReview' | 'failed' | 'pending' | 'submitted7d';
const BUCKETS: Bucket[] = ['awaitingReview', 'failed', 'pending', 'submitted7d'];
const ACTIONS: Record<string, AdminAction[]> = { awaiting_review: ['approve', 'reject'], failed: ['requeue', 'reject'], pending: ['reject'] };

/**
 * In-app ops page. Gated by /api/me `admin` (Google-verified allow-listed email); the Worker enforces it on every
 * call, this screen only decides what to show. One screen, no charts: engine strip + four buckets with row actions.
 */
export default function Admin() {
  const t = useT();
  const session = useSession();
  const [adminFlag, setAdminFlag] = useState<boolean | null>(null); // null = not checked yet for this session
  const gate: Gate = !session ? 'signedOut' : adminFlag == null ? 'checking' : adminFlag ? 'admin' : 'notAdmin';
  const [data, setData] = useState<AdminOverview | null>(null);
  const [err, setErr] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // report id or 'engine'
  const [tab, setTab] = useState<'queue' | 'system'>(() => (location.hash === '#system' ? 'system' : 'queue'));

  const say = useCallback((msg: string) => { setToast(msg); window.setTimeout(() => setToast(null), 3500); }, []);

  const load = useCallback(async () => {
    try { setData(await adminOverview()); setErr(false); } catch { setErr(true); }
  }, []);

  // Gate: signed in → ask /api/me for the admin flag (the Worker is the authority; this is just routing).
  useEffect(() => {
    if (!session) return;
    let live = true;
    getMe().then((m) => { if (live) setAdminFlag(m.admin === true); }).catch(() => { if (live) setAdminFlag(false); });
    return () => { live = false; setAdminFlag(null); setData(null); };
  }, [session]);
  // Load on entry, then refresh every minute while visible.
  useEffect(() => {
    if (gate !== 'admin') return;
    void load();
    const tick = () => { if (document.visibilityState === 'visible') void load(); };
    const iv = window.setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(iv); document.removeEventListener('visibilitychange', tick); };
  }, [gate, load]);

  async function act(r: AdminReport, action: AdminAction) {
    setBusy(r.id);
    try {
      const after = await adminAct(r.id, action);
      setData((d) => d && rebucket(d, after));
      say(t(`admin.done.${action}`));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { say(t('admin.conflict', { status: e.code })); load(); } // state moved under us → resync
      else say(t('admin.error'));
    } finally { setBusy(null); }
  }
  async function engine(op: 'pause' | 'resume') {
    setBusy('engine');
    try { const r = await adminEngine(op); setData((d) => d && { ...d, engine: { ...d.engine, paused: r.paused, consecutiveFailures: op === 'resume' ? 0 : d.engine.consecutiveFailures } }); say(t(op === 'pause' ? 'admin.engine.pausedToast' : 'admin.engine.resumed')); }
    catch { say(t('admin.error')); } finally { setBusy(null); }
  }

  if (gate === 'signedOut') {
    return (
      <section className="section admin">
        <h1 className="admin-h1">{t('admin.title')}</h1>
        <p className="muted">{t('admin.signIn')}</p>
        <GoogleSignInButton className="account-google" label={t('account.google')} width={280} />
      </section>
    );
  }
  if (gate === 'checking') return <section className="section admin"><p className="muted" aria-busy="true">{t('account.loading')}</p></section>;
  if (gate === 'notAdmin') return <section className="section admin"><h1 className="admin-h1">{t('admin.title')}</h1><p className="muted">{t('admin.notAdmin')}</p></section>;

  const tabs = (
    <div className="admin-tabs" role="tablist" aria-label={t('admin.title')}>
      {(['queue', 'system'] as const).map((k) => (
        <button key={k} type="button" role="tab" className="chip" aria-selected={tab === k} onClick={() => { setTab(k); history.replaceState(null, '', k === 'system' ? '#system' : '#'); }}>{t(`admin.tab.${k}`)}</button>
      ))}
    </div>
  );
  if (tab === 'system') {
    return <section className="section admin"><h1 className="admin-h1">{t('admin.title')}</h1>{tabs}<AdminSystem /></section>;
  }

  return (
    <section className="section admin" aria-live="polite">
      <h1 className="admin-h1">{t('admin.title')}</h1>
      {tabs}
      {err && <div className="notice notice-error" role="alert">{t('admin.loadError')} <button type="button" className="btn btn-ghost" onClick={load}>{t('account.retry')}</button></div>}
      {!data ? <p className="muted" aria-busy="true">{t('account.loading')}</p> : (
        <>
          <div className={`card admin-engine${data.engine.paused ? ' is-paused' : ''}`}>
            <div className="admin-engine-row">
              <span className="label">{t('admin.engine.label')}</span>
              <strong>{data.engine.paused ? t('admin.engine.paused') : t('admin.engine.running')}</strong>
              <span>{t('admin.engine.failures', { n: data.engine.consecutiveFailures })}</span>
              <span>{t('admin.engine.hour', { n: data.engine.submissionsThisHour })}</span>
              <span>{t('admin.engine.mode', { mode: data.engine.hitlMode, n: data.engine.accountTrustN })}</span>
              {data.engine.lastSubmissionTime && <span className="admin-meta">{t('admin.engine.last', { when: age(data.engine.lastSubmissionTime) })}</span>}
            </div>
            <div className="admin-actions">
              {data.engine.paused
                ? <button type="button" className="btn btn-primary" disabled={busy === 'engine'} onClick={() => engine('resume')}>{t('admin.engine.resume')}</button>
                : <button type="button" className="btn btn-secondary" disabled={busy === 'engine'} onClick={() => engine('pause')}>{t('admin.engine.pause')}</button>}
              <button type="button" className="btn btn-ghost" onClick={load}>{t('admin.refresh')}</button>
            </div>
          </div>

          {BUCKETS.map((b) => (
            <div className="admin-section" key={b}>
              <h2>{t(`admin.bucket.${b}`)} <span className="admin-count">{data[b].length}</span></h2>
              {data[b].length === 0 ? <p className="admin-empty">{t('admin.bucket.empty')}</p> : (
                <ul className="admin-list">
                  {data[b].map((r) => <Row key={r.id} r={r} busy={busy === r.id} onAct={(a) => act(r, a)} />)}
                </ul>
              )}
            </div>
          ))}
        </>
      )}
      {toast && <div className="notice notice-ok admin-toast" role="status">{toast}</div>}
    </section>
  );
}

function Row({ r, busy, onAct }: { r: AdminReport; busy: boolean; onAct: (a: AdminAction) => void }) {
  const t = useT();
  const actions = ACTIONS[r.status] ?? [];
  return (
    <li className="card admin-row">
      <div className="admin-row-head">
        <span><CategoryIcon k={r.category} size={18} /> <strong>{r.categoryLabel}</strong></span>
        <span className="admin-meta"><a href={`/r/${r.id}`} target="_blank" rel="noopener">{age(r.createdAt)}</a></span>
      </div>
      <div className="admin-meta">{r.address}{r.portalCaseId ? ` · ${r.portalCaseId}` : ''}{r.portalStatus ? ` · ${r.portalStatus}` : ''}</div>
      {r.intakeFlags.length > 0 && <div className="admin-flags">{r.intakeFlags.map((f) => <span key={f} className="admin-flag">{f}</span>)}</div>}
      <div className={`admin-body${r.photoUrl ? ' has-photo' : ''}`}>
        <div>
          {r.description ? <p className="admin-desc">{r.description}</p> : <p className="admin-orig">{t('admin.noDescription')}</p>}
          {r.descriptionOriginal && r.descriptionOriginal !== r.description && <p className="admin-orig">{t('admin.original')}: {r.descriptionOriginal}</p>}
          {r.extra && Object.keys(r.extra).length > 0 && <p className="admin-orig">{Object.entries(r.extra).map(([k, v]) => `${k}: ${v}`).join(' · ')}</p>}
        </div>
        {r.photoUrl && <a href={r.photoUrl} target="_blank" rel="noopener"><img className="admin-thumb" src={r.photoUrl} alt="" loading="lazy" /></a>}
      </div>
      <p className="admin-detail">{r.reporterEmail ?? t('admin.noEmail')}{r.statusDetail ? ` · ${r.statusDetail}` : ''}{r.retries ? ` · ${t('admin.retries', { n: r.retries })}` : ''}</p>
      {actions.length > 0 && (
        <div className="admin-actions">
          {actions.map((a) => (
            <button key={a} type="button" className={`btn ${a === 'reject' ? 'btn-ghost' : 'btn-primary'}`} disabled={busy} onClick={() => onAct(a)}>{t(`admin.action.${a}`)}</button>
          ))}
        </div>
      )}
    </li>
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

function age(iso: string | null): string {
  if (!iso) return '';
  const sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(sec)) return '';
  if (sec < 60) return 'now';
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86_400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86_400)}d`;
}
