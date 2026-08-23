import { Fragment, useCallback, useEffect, useState } from 'react';
import { useT } from '../i18n';
import {
  adminCategories, adminHealth,
  type AdminCanary, type AdminCanaryCategory, type AdminCategory, type AdminHealth, type AdminReconcile, type AdminSync, type Light,
} from '../api/admin';
import { shortLabel } from '../lib/categories';
import { Dot, abs, rel } from './adminUtil';
import './Admin.css';
import './AdminPortal.css';

type Tr = ReturnType<typeof useT>;
/** Runtime carries per-report id lists the shared AdminReconcile type doesn't declare (docs/api.md). */
type ReconcileIds = { adopted?: string[]; stranded?: string[]; missing?: string[] };
type FieldSource = { from?: string; value?: string; default?: string } | null;

/**
 * /admin → Portal: everything about the city side of the pipeline. Category → case-type mapping and its
 * Step-3 field sources, the drift canary, and DB↔portal sync — the levers that decide whether a filing lands.
 * Categories from GET /api/admin/categories; sync + canary from GET /api/admin/health (events=0).
 */
export default function AdminPortal() {
  const t = useT();
  const [cats, setCats] = useState<AdminCategory[] | null>(null);
  const [catsErr, setCatsErr] = useState(false);
  const [health, setHealth] = useState<AdminHealth | null>(null);
  const [healthErr, setHealthErr] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const loadCats = useCallback(async () => {
    try { setCatsErr(false); setCats((await adminCategories()).items); } catch { setCatsErr(true); }
  }, []);
  const loadHealth = useCallback(async () => {
    try { setHealthErr(false); setHealth(await adminHealth(0)); } catch { setHealthErr(true); }
  }, []);
  useEffect(() => { void loadCats(); void loadHealth(); }, [loadCats, loadHealth]);

  return (
    <div className="admin-portal">
      <section className="portal-section">
        <h2>{t('admin.portal.cats.title')}</h2>
        <p className="portal-intro">
          {t('admin.portal.cats.intro')}{' '}
          <a href="#explain:portal">{t('admin.portal.explainLink')}</a>
        </p>

        {!cats ? (
          catsErr
            ? <div className="notice notice-error" role="alert">{t('admin.loadError')} <button type="button" className="btn btn-ghost" onClick={() => void loadCats()}>{t('account.retry')}</button></div>
            : <p className="muted" aria-busy="true">{t('account.loading')}</p>
        ) : cats.length === 0 ? (
          <p className="admin-empty">{t('admin.portal.cats.empty')}</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table portal-table">
              <thead>
                <tr>
                  <th scope="col">{t('admin.portal.col.category')}</th>
                  <th scope="col">{t('admin.portal.col.caseType')}</th>
                  <th scope="col">{t('admin.portal.col.requestType')}</th>
                  <th scope="col">{t('admin.portal.col.fields')}</th>
                  <th scope="col">{t('admin.portal.col.photo')}</th>
                  <th scope="col">{t('admin.portal.col.seasonal')}</th>
                  <th scope="col">{t('admin.portal.col.golden')}</th>
                  <th scope="col" className="portal-num">{t('admin.portal.col.submitted')}</th>
                  <th scope="col" className="portal-num">{t('admin.portal.col.rejected')}</th>
                </tr>
              </thead>
              <tbody>
                {cats.map((c) => {
                  const open = expanded === c.key;
                  const toggle = () => setExpanded((k) => (k === c.key ? null : c.key));
                  return (
                    <Fragment key={c.key}>
                    <tr className={open ? 'is-open' : ''} onClick={toggle}>
                      <td className="portal-cat">
                        <div><button type="button" className="portal-expand" aria-expanded={open} onClick={(e) => { e.stopPropagation(); toggle(); }}>{c.label}</button></div>
                        <div><span className="sys-kind">{c.key}</span></div>
                      </td>
                      <td className="portal-casetype">
                        <div>{c.portalCaseTypeName ?? <span className="admin-meta">{t('admin.portal.none')}</span>}</div>
                        {c.portalCaseTypeGuid && <div><span className="sys-kind" title={c.portalCaseTypeGuid}>{c.portalCaseTypeGuid}</span></div>}
                        {c.portalSearchTerm && <div className="admin-meta">{c.portalSearchTerm}</div>}
                      </td>
                      <td>{c.requestType ? <span className="sys-kind">{c.requestType}</span> : <span className="admin-meta">{t('admin.portal.none')}</span>}</td>
                      <td><Fields fields={c.fields} t={t} /></td>
                      <td><YesNo v={c.photoRequired} t={t} /></td>
                      <td>{c.seasonal ? <span className="sys-kind">{c.seasonal}</span> : <span className="admin-meta">{t('admin.portal.none')}</span>}</td>
                      <td><Golden g={c.golden} t={t} /></td>
                      <td className="portal-num">{c.counts.submitted}</td>
                      <td className="portal-num">{c.counts.rejected}</td>
                    </tr>
                    {open && (
                      <tr className="portal-json-row">
                        <td colSpan={9}><pre className="portal-json">{JSON.stringify(c, null, 2)}</pre></td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="portal-section">
        <h2>{t('admin.portal.city.title')}</h2>
        <p className="portal-intro">
          {t('admin.portal.city.intro')}{' '}
          <a href="#explain:portal">{t('admin.portal.explainLink')}</a>
        </p>

        {!health ? (
          healthErr
            ? <div className="notice notice-error" role="alert">{t('admin.loadError')} <button type="button" className="btn btn-ghost" onClick={() => void loadHealth()}>{t('account.retry')}</button></div>
            : <p className="muted" aria-busy="true">{t('account.loading')}</p>
        ) : (
          <div className="portal-cards">
            <div className="portal-card">
              <h3>{t('admin.sync.title')}</h3>
              <SyncCard sync={health.sync} t={t} />
            </div>
            <div className="portal-card">
              <h3>{t('admin.canary.title')}</h3>
              {health.canary ? <CanaryCard canary={health.canary} t={t} /> : <p className="admin-empty">{t('admin.portal.canary.off')}</p>}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

const YesNo = ({ v, t }: { v: boolean; t: Tr }) => (
  <span className="portal-yn"><Dot status={v ? 'ok' : 'unknown'} /> {v ? t('admin.portal.yes') : t('admin.portal.no')}</span>
);

/** Step-3 control → value source chips. `from` = report path (with its default), `value` = a constant. */
function Fields({ fields, t }: { fields: Record<string, unknown> | null; t: Tr }) {
  const entries = fields ? Object.entries(fields) : [];
  if (entries.length === 0) return <span className="admin-meta">{t('admin.portal.noFields')}</span>;
  return (
    <div className="portal-chips">
      {entries.map(([k, raw]) => {
        const f = (raw && typeof raw === 'object' ? raw : null) as FieldSource;
        const source = f?.from ?? (f?.value != null ? `"${f.value}"` : String(raw));
        return (
          <span key={k} className="portal-field">
            <span className="sys-kind">{k} → {source}</span>
            {f?.default != null && <span className="portal-default">{t('admin.portal.fieldDefault', { v: f.default })}</span>}
          </span>
        );
      })}
    </div>
  );
}

/** Drift golden: dot from drifted/source, text = "live · minted <rel>" / "sim" / "none", plus last live check. */
function Golden({ g, t }: { g: AdminCategory['golden']; t: Tr }) {
  const src = g?.source ?? null;
  const status: Light = g?.drifted ? 'error' : src === 'live' ? 'ok' : src === 'sim' ? 'warn' : 'unknown';
  const text = src === 'live' ? t('admin.portal.golden.live', { when: rel(g?.at, t) })
    : src === 'sim' ? t('admin.portal.golden.sim')
    : t('admin.portal.golden.none');
  return (
    <div className="portal-golden">
      <span className="portal-yn">
        <Dot status={status} /> <span title={abs(g?.at)}>{text}</span>
        {g?.drifted && <span className="canary-pill">{t('admin.canary.drifted')}</span>}
      </span>
      {src != null && <span className="admin-meta" title={abs(g?.lastLiveAt)}>{t('admin.portal.golden.lastLive', { when: rel(g?.lastLiveAt, t) })}</span>}
    </div>
  );
}

/** DB↔portal agreement (re-implemented from AdminSystem's SyncCard; adds the reconcile id lists as chips). */
function SyncCard({ sync, t }: { sync: AdminSync; t: Tr }) {
  const r = sync.reconcile;
  const ids = (r as (AdminReconcile & { ids?: ReconcileIds }) | null)?.ids;
  return (
    <div className="card sync-card">
      <div className={`sync-banner is-${sync.status}`} role="status">
        <Dot status={sync.status} /><strong>{t(`admin.sync.status.${sync.status}`)}</strong>
      </div>
      <div className="sync-rows">
        <div className="sync-row">
          <div className="sync-row-head">
            <span className="sync-label">{t('admin.sync.pending')}</span>
            <b className="sync-val">{sync.caseIdPending}{sync.caseIdPendingOldestAt && <span className="sync-oldest"> · {t('admin.sync.pendingOldest', { when: rel(sync.caseIdPendingOldestAt, t) })}</span>}</b>
          </div>
          <p className="sync-what">{t('admin.sync.pendingWhat')}</p>
        </div>
        <div className="sync-row">
          <div className="sync-row-head">
            <span className="sync-label">{t('admin.sync.lastReconcile')}</span>
            <b className="sync-val">{r?.at ? rel(r.at, t) : t('admin.sync.never')}{r?.at && <span className="sync-oldest"> · {abs(r.at)}</span>}</b>
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
        {ids && (['adopted', 'stranded', 'missing'] as const).map((k) => {
          const list = ids[k] ?? [];
          if (list.length === 0) return null;
          return (
            <div key={k} className="portal-id-group">
              <span className="sync-count-label">{t(`admin.sync.${k}`)} <span className="admin-meta">({list.length})</span></span>
              <div className="portal-chips">{list.map((id) => <span key={id} className="sys-kind">{id}</span>)}</div>
            </div>
          );
        })}
        {r?.error && <div className="sync-err" role="alert"><strong>{t('admin.sync.error')}</strong> {r.error}</div>}
      </div>
    </div>
  );
}

const SyncCount = ({ n, label, what, warn }: { n: number; label: string; what: string; warn?: boolean }) => (
  <div className={`sync-count${warn ? ' is-warn' : ''}`}><b>{n}</b><span className="sync-count-label">{label}</span><span className="sync-count-what">{what}</span></div>
);

/** Form-drift canary (re-implemented from AdminSystem's CanaryCard). */
function CanaryCard({ canary, t }: { canary: AdminCanary; t: Tr }) {
  const cats = canary.categories;
  const status: 'ok' | 'warn' | 'error' | 'off' = !canary.enabled ? 'off'
    : cats.some((c) => c.drifted) ? 'error'
    : !cats.some((c) => c.goldenSource === 'live') ? 'warn'
    : 'ok';
  return (
    <div className="card canary-card">
      <div className={`canary-banner is-${status}`} role="status">
        <Dot status={status === 'off' ? 'unknown' : status} /><strong>{t(`admin.canary.status.${status}`)}</strong>
      </div>
      {cats.length === 0
        ? <p className="admin-empty">{t('admin.canary.none')}</p>
        : <ul className="canary-rows">{cats.map((c) => <CanaryRow key={c.category} c={c} t={t} />)}</ul>}
    </div>
  );
}

function CanaryRow({ c, t }: { c: AdminCanaryCategory; t: Tr }) {
  const source = c.goldenSource ?? 'none';
  return (
    <li className={`canary-row${c.drifted ? ' is-drifted' : ''}`}>
      <div className="canary-row-head">
        <span className="canary-cat">{shortLabel(c.category, t)}</span>
        <span className={`canary-chip canary-chip--${source}`}>{t(`admin.canary.source.${source}`)}</span>
        {c.drifted && <span className="canary-pill">{t('admin.canary.drifted')}</span>}
      </div>
      <div className="canary-meta">
        <span title={abs(c.goldenAt)}>{t('admin.canary.golden', { when: rel(c.goldenAt, t) })}</span>
        <span title={abs(c.lastLiveAt)}>{t('admin.canary.lastLive', { when: rel(c.lastLiveAt, t) })}</span>
      </div>
    </li>
  );
}
