import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useT } from '../i18n';
import { adminHealth, type AdminCanary, type AdminCanaryCategory, type AdminEvent, type AdminHealth, type AdminSync, type Light, type Subsystem } from '../api/admin';
import { shortLabel } from '../lib/categories';
import './Admin.css';

type Filter = 'all' | 'errors' | 'reports' | 'admin';
const FILTERS: Filter[] = ['all', 'errors', 'reports', 'admin'];
const COUNT_KEYS = ['pending', 'awaiting_review', 'processing', 'submitted', 'failed', 'rejected', 'auto-rejected'] as const;

/**
 * /admin → System: "is the machine healthy, and what has it been doing?" Banner + subsystem traffic lights +
 * numbers + event stream, all from one GET /api/admin/health. Explanations ride along in each subsystem's `what`.
 */
export default function AdminSystem() {
  const t = useT();
  const [data, setData] = useState<AdminHealth | null>(null);
  const [err, setErr] = useState(false);
  const [limit, setLimit] = useState(100);
  const [filter, setFilter] = useState<Filter>('all');

  const load = useCallback(async (n = limit) => {
    try { setData(await adminHealth(n)); setErr(false); } catch { setErr(true); }
  }, [limit]);
  useEffect(() => {
    void load();
    const tick = () => { if (document.visibilityState === 'visible') void load(); };
    const iv = window.setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(iv); document.removeEventListener('visibilitychange', tick); };
  }, [load]);

  if (!data) return err
    ? <div className="notice notice-error" role="alert">{t('admin.loadError')} <button type="button" className="btn btn-ghost" onClick={() => load()}>{t('account.retry')}</button></div>
    : <p className="muted" aria-busy="true">{t('account.loading')}</p>;

  const events = data.events.filter((e) => matches(e, filter));
  return (
    <div className="admin-system">
      {err && <div className="notice notice-error" role="alert">{t('admin.loadError')}</div>}
      <div className={`card sys-banner is-${data.overall}`} role="status">
        <Dot status={data.overall} />
        <strong>{t(`admin.sys.overall.${data.overall}`)}</strong>
        <span>{data.engine.paused ? t('admin.engine.paused') : t('admin.engine.running')}</span>
        <span className="sys-time">{t('admin.sys.generated', { when: rel(data.generatedAt, t) })}</span>
        <button type="button" className="btn btn-ghost" onClick={() => load()}>{t('admin.refresh')}</button>
      </div>

      <div className="admin-section">
        <h2>{t('admin.sys.subsystems')}</h2>
        <div className="sys-grid">{data.subsystems.map((s) => <SubsystemCard key={s.key} s={s} />)}</div>
      </div>

      {data.sync && (
        <div className="admin-section">
          <h2>{t('admin.sync.title')}</h2>
          <SyncCard sync={data.sync} />
        </div>
      )}

      {data.canary && (
        <div className="admin-section">
          <h2>{t('admin.canary.title')}</h2>
          <CanaryCard canary={data.canary} />
        </div>
      )}

      <div className="admin-section">
        <h2>{t('admin.sys.numbers')}</h2>
        <div className="sys-numbers">
          {COUNT_KEYS.map((k) => <Num key={k} n={data.counts[k] ?? 0} label={t(`admin.sys.count.${k}`)} />)}
          <Num n={data.users} label={t('admin.sys.users')} />
          <Num n={`${data.ai.intakeToday} / ${data.ai.dailyCap}`} label={t('admin.sys.ai')} />
          <Num n={data.cityFeed.items} label={t('admin.sys.cityFeed', { when: rel(data.cityFeed.fetchedAt, t) })} />
          <Num n={data.engine.submissionsThisHour} label={t('admin.sys.thisHour')} />
          <Num n={rel(data.engine.lastSubmissionTime, t)} label={t('admin.sys.lastSent')} />
          <Num n={`${data.engine.hitlMode} · ${data.engine.accountTrustN}`} label={t('admin.sys.hitl')} />
          <Num n={data.engine.reporterEmailEnabled ? t('admin.sys.on') : t('admin.sys.off')} label={t('admin.sys.reporterEmail')} />
        </div>
      </div>

      <div className="admin-section">
        <h2>{t('admin.sys.events')} <span className="admin-count">{events.length}</span></h2>
        <div className="sys-filters" role="group" aria-label={t('admin.sys.filter')}>
          {FILTERS.map((f) => <button key={f} type="button" className="chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>{t(`admin.sys.filter.${f}`)}</button>)}
        </div>
        {events.length === 0 ? <p className="admin-empty">{t('admin.bucket.empty')}</p> : (
          <ul className="sys-events">{events.map((e) => <EventRow key={e.id} e={e} />)}</ul>
        )}
        {data.events.length >= limit && limit < 300 && (
          <button type="button" className="btn btn-ghost" onClick={() => { setLimit(300); void load(300); }}>{t('admin.sys.more')}</button>
        )}
      </div>
    </div>
  );
}

function SubsystemCard({ s }: { s: Subsystem }) {
  const t = useT();
  return (
    <div className={`card sys-card sys-card--${s.status}`}>
      <div className="sys-card-head"><Dot status={s.status} /><strong>{s.label}</strong><span className="sys-light">{t(`admin.sys.light.${s.status}`)}</span></div>
      <p className="sys-what">{s.what}</p>
      <div className="sys-meta">
        {s.status === 'unknown' && !s.lastOkAt ? <span>{t('admin.sys.neverRan')}</span> : <span>{t('admin.sys.lastOk', { when: rel(s.lastOkAt, t) })}</span>}
        {s.expectedEvery && <span>{t('admin.sys.expected', { every: s.expectedEvery })}</span>}
        <span>{t('admin.sys.today', { ok: s.okToday, err: s.errToday })}</span>
      </div>
      {s.status !== 'ok' && s.lastError && (
        <div className="sys-err" role="alert">{s.lastError}<small>{rel(s.lastErrorAt, t)}{s.lastDetail ? ` · ${s.lastDetail}` : ''}</small></div>
      )}
    </div>
  );
}

/** DB ↔ portal agreement: how many reports still await a case number, and what the nightly reconcile last found. */
function SyncCard({ sync }: { sync: AdminSync }) {
  const t = useT();
  const r = sync.reconcile;
  return (
    <div className="card sync-card">
      <div className={`sync-banner is-${sync.status}`} role="status">
        <Dot status={sync.status} />
        <strong>{t(`admin.sync.status.${sync.status}`)}</strong>
      </div>
      <div className="sync-rows">
        <div className="sync-row">
          <div className="sync-row-head">
            <span className="sync-label">{t('admin.sync.pending')}</span>
            <b className="sync-val">
              {sync.caseIdPending}
              {sync.caseIdPendingOldestAt && <span className="sync-oldest"> · {t('admin.sync.pendingOldest', { when: rel(sync.caseIdPendingOldestAt, t) })}</span>}
            </b>
          </div>
          <p className="sync-what">{t('admin.sync.pendingWhat')}</p>
        </div>
        <div className="sync-row">
          <div className="sync-row-head">
            <span className="sync-label">{t('admin.sync.lastReconcile')}</span>
            <b className="sync-val">
              {r?.at ? rel(r.at, t) : t('admin.sync.never')}
              {r?.at && <span className="sync-oldest"> · {abs(r.at)}</span>}
            </b>
          </div>
          <p className="sync-what">{t('admin.sync.reconcileWhat')}</p>
        </div>
        {r && (
          <div className="sync-counts">
            <SyncCount n={r.scanned} label={t('admin.sync.scanned')} what={t('admin.sync.scannedWhat')} />
            <SyncCount n={r.adopted} label={t('admin.sync.adopted')} what={t('admin.sync.adoptedWhat')} />
            <SyncCount n={r.stranded} label={t('admin.sync.stranded')} what={t('admin.sync.strandedWhat')} />
            <SyncCount n={r.missing} label={t('admin.sync.missing')} what={t('admin.sync.missingWhat')} warn={r.missing > 0} />
          </div>
        )}
        {r?.error && <div className="sync-err" role="alert"><strong>{t('admin.sync.error')}</strong> {r.error}</div>}
      </div>
    </div>
  );
}

const SyncCount = ({ n, label, what, warn }: { n: number; label: string; what: string; warn?: boolean }) => (
  <div className={`sync-count${warn ? ' is-warn' : ''}`}>
    <b>{n}</b>
    <span className="sync-count-label">{label}</span>
    <span className="sync-count-what">{what}</span>
  </div>
);

/** Portal form-drift canary: the daily resume walk diffs the city's Step-3 controls against a golden per category.
 *  Off = disabled; error = the city changed a form; warn = a category has no live baseline yet (first run mints it). */
function CanaryCard({ canary }: { canary: AdminCanary }) {
  const t = useT();
  const cats = canary.categories;
  const status: 'ok' | 'warn' | 'error' | 'off' = !canary.enabled ? 'off'
    : cats.some((c) => c.drifted) ? 'error'
    : !cats.some((c) => c.goldenSource === 'live') ? 'warn' // sim-only rows are fine: they get a live golden from the next real report
    : 'ok';
  return (
    <div className="card canary-card">
      <div className={`canary-banner is-${status}`} role="status">
        <Dot status={status === 'off' ? 'unknown' : status} />
        <strong>{t(`admin.canary.status.${status}`)}</strong>
      </div>
      {cats.length === 0
        ? <p className="admin-empty">{t('admin.canary.none')}</p>
        : <ul className="canary-rows">{cats.map((c) => <CanaryRow key={c.category} c={c} />)}</ul>}
    </div>
  );
}

function CanaryRow({ c }: { c: AdminCanaryCategory }) {
  const t = useT();
  const source = c.goldenSource ?? 'none';
  return (
    <li className={`canary-row${c.drifted ? ' is-drifted' : ''}`}>
      <div className="canary-row-head">
        <span className="canary-cat">{shortLabel(c.category, t)}</span>
        <span className={`canary-chip canary-chip--${source}`}>{t(`admin.canary.source.${source}`)}</span>
        {c.drifted && <span className="canary-pill">{t('admin.canary.drifted')}</span>}
      </div>
      <div className="canary-meta">
        <span>{t('admin.canary.golden', { when: rel(c.goldenAt, t) })}</span>
        <span>{t('admin.canary.lastLive', { when: rel(c.lastLiveAt, t) })}</span>
      </div>
    </li>
  );
}

function EventRow({ e }: { e: AdminEvent }) {
  const t = useT();
  return (
    <li className={`card sys-event sys-event--${e.level}`}>
      <Dot status={e.level === 'info' ? 'ok' : e.level} />
      <div>
        <div className="sys-event-head">
          <span className="sys-kind">{e.kind}</span>
          <span className="sys-time">{rel(e.at, t)}</span>
          {e.reportId && <Link to={`/r/${e.reportId}`} className="sys-time">{e.reportId.slice(0, 8)}…</Link>}
        </div>
        <p className="sys-msg">{e.msg}</p>
      </div>
    </li>
  );
}

const Dot = ({ status }: { status: Light | 'warn' | 'error' }) => <span className={`sys-dot sys-dot--${status}`} aria-hidden="true" />;
const Num = ({ n, label }: { n: number | string; label: string }) => <div className="card sys-num"><b>{n}</b><span>{label}</span></div>;

function matches(e: AdminEvent, f: Filter): boolean {
  if (f === 'all') return true;
  if (f === 'errors') return e.level === 'error' || e.level === 'warn';
  if (f === 'reports') return /^(report|hitl|submit)\./.test(e.kind) || !!e.reportId;
  return /^admin\./.test(e.kind);
}

/** Absolute local timestamp, e.g. "Aug 22, 2:14 PM". Empty for an unparseable value. */
function abs(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '';
}

/** Relative time: "2 min ago" / "3 h ago" / "never". */
function rel(iso: string | null | undefined, t: (k: string, v?: Record<string, string | number>) => string): string {
  if (!iso) return t('admin.sys.never');
  const sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(sec)) return t('admin.sys.never');
  if (sec < 45) return t('admin.sys.justNow');
  if (sec < 3600) return t('admin.sys.ago', { v: `${Math.round(sec / 60)} min` });
  if (sec < 86_400) return t('admin.sys.ago', { v: `${Math.round(sec / 3600)} h` });
  return t('admin.sys.ago', { v: `${Math.round(sec / 86_400)} d` });
}
