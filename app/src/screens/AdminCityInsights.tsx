import { Fragment, useEffect, useState } from 'react';
import { useT } from '../i18n';
import { adminCityInsights, type CityInsights, type CityOutcome, type CityStats } from '../api/admin';
import { abs } from './adminUtil';
import './AdminCityInsights.css';

/** Fixed order = fixed colour slot (AdminCityInsights.css --oc-*); "open" is the neutral remainder. */
export const OUTCOMES: CityOutcome[] = ['work_done', 'enforcement', 'referred', 'logged_elsewhere', 'info_only', 'no_action', 'cancelled', 'open'];

/**
 * "How it gets done" — what the city does with cases once they are routed, from the stored public-feed record
 * (worker cityinsights.ts): per group and case type, routing and closing times and what closing meant.
 */
export default function AdminCityInsights({ onType }: { onType: (caseType: string) => void }) {
  const t = useT();
  const [days, setDays] = useState(30);
  const [data, setData] = useState<CityInsights | null>(null);
  const [err, setErr] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    let live = true; setData(null);
    adminCityInsights(days).then((d) => { if (live) { setData(d); setErr(false); } }).catch(() => { if (live) setErr(true); });
    return () => { live = false; };
  }, [days]);
  const toggle = (g: string) => setOpen((s) => { const n = new Set(s); if (n.has(g)) n.delete(g); else n.add(g); return n; });
  const hours = (h: number | null) => (h == null ? '—' : h < 1 ? t('admin.ci.minutes', { n: Math.max(1, Math.round(h * 60)) }) : t('admin.ci.hours', { n: h }));

  return (
    <div className="ci">
      <div className="admin-filters">
        <label className="admin-filter"><span className="label">{t('admin.ci.window')}</span>
          <select className="select" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[7, 30, 90, 365].map((d) => <option key={d} value={d}>{t('admin.ci.days', { n: d })}</option>)}
          </select></label>
        {data && <span className="admin-meta">{t('admin.ci.asOf', { when: abs(data.at), since: data.trackedSince ? abs(data.trackedSince) : '—' })}</span>}
      </div>
      {err && <div className="notice notice-error" role="alert">{t('admin.loadError')}</div>}
      {!data ? (!err && <p className="muted" aria-busy="true">{t('account.loading')}</p>) : data.total.n === 0 ? <p className="admin-empty">{t('admin.bucket.empty')}</p> : (
        <>
          <dl className="ci-tiles">
            <div><dt>{t('admin.ci.cases')}</dt><dd>{data.total.n}</dd></div>
            <div><dt>{t('admin.ci.routedIn')}</dt><dd>{hours(data.total.medRouteHours)}</dd></div>
            <div><dt>{t('admin.ci.closed')}</dt><dd>{pct(data.total.closed, data.total.n)}</dd></div>
            <div><dt>{t('admin.ci.closeIn')}</dt><dd>{data.total.medCloseDays == null ? '—' : t('admin.ci.daysShort', { n: data.total.medCloseDays })}<span className="admin-meta"> {t('admin.ci.over', { n: data.total.closeSample })}</span></dd></div>
            <div><dt>{t('admin.ci.workDone')}</dt><dd>{pct(data.total.outcomes.work_done, data.total.closed)}<span className="admin-meta"> {t('admin.ci.ofClosed')}</span></dd></div>
            <div><dt>{t('admin.ci.stale')}</dt><dd>{data.total.openOver7d}</dd></div>
          </dl>
          <ul className="ci-legend" aria-label={t('admin.ci.legend')}>
            {OUTCOMES.map((o) => <li key={o}><span className={`ci-sw ci-oc-${o}`} aria-hidden="true" />{t(`admin.ci.oc.${o}`)}</li>)}
          </ul>
          <table className="admin-table ci-table">
            <thead><tr>
              <th scope="col">{t('admin.ci.what')}</th><th scope="col" className="ci-num">{t('admin.ci.cases')}</th><th scope="col" className="ci-num">{t('admin.ci.routedIn')}</th>
              <th scope="col" className="ci-num">{t('admin.ci.closed')}</th><th scope="col" className="ci-num">{t('admin.ci.closeIn')}</th>
              <th scope="col" className="ci-bar-col">{t('admin.ci.meant')}</th><th scope="col" className="ci-num">{t('admin.ci.stale')}</th>
            </tr></thead>
            <tbody>
              {data.groups.map((g) => (
                <Fragment key={g.group}>
                  <tr className="ci-group" onClick={() => toggle(g.group)} tabIndex={0} aria-expanded={open.has(g.group)} onKeyDown={(e) => { if (e.key === 'Enter') toggle(g.group); }}>
                    <th scope="row"><span className="ci-caret" aria-hidden="true">{open.has(g.group) ? '▾' : '▸'}</span> {t(`group.${g.group}`)}</th>
                    <Cells s={g} hours={hours} />
                  </tr>
                  {open.has(g.group) && g.types.map((ty) => (
                    <tr key={ty.caseType} className="ci-type" onClick={() => onType(ty.caseType)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') onType(ty.caseType); }} title={t('admin.ci.viewCases')}>
                      <th scope="row">{ty.caseType}
                        {ty.examples.length > 0 && <ul className="ci-ex">{ty.examples.map((x) => <li key={x.text}>“{x.text}”{x.n > 1 ? ` ×${x.n}` : ''}</li>)}</ul>}
                      </th>
                      <Cells s={ty} hours={hours} />
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
          <p className="admin-meta ci-foot">{t('admin.ci.how')}</p>
        </>
      )}
    </div>
  );
}

function pct(a: number, b: number) { return b ? `${Math.round((100 * a) / b)}%` : '—'; }

function Cells({ s, hours }: { s: CityStats; hours: (h: number | null) => string }) {
  const t = useT();
  const parts = OUTCOMES.filter((o) => s.outcomes[o] > 0);
  const top = [...parts].filter((o) => o !== 'open').sort((a, b) => s.outcomes[b] - s.outcomes[a]).slice(0, 2);
  return (
    <>
      <td className="ci-num">{s.n}</td>
      <td className="ci-num">{hours(s.medRouteHours)}</td>
      <td className="ci-num">{pct(s.closed, s.n)}</td>
      <td className="ci-num">{s.medCloseDays == null ? '—' : t('admin.ci.daysShort', { n: s.medCloseDays })}</td>
      <td className="ci-bar-col">
        <div className="ci-bar" role="img" aria-label={parts.map((o) => `${t(`admin.ci.oc.${o}`)} ${s.outcomes[o]}`).join(', ')}>
          {parts.map((o) => <span key={o} className={`ci-seg ci-oc-${o}`} style={{ flexGrow: s.outcomes[o] }} title={`${t(`admin.ci.oc.${o}`)}: ${s.outcomes[o]} (${pct(s.outcomes[o], s.n)})`} />)}
        </div>
        {top.length > 0 && <div className="admin-meta ci-top">{top.map((o) => `${t(`admin.ci.oc.${o}`)} ${s.outcomes[o]}`).join(' · ')}</div>}
      </td>
      <td className="ci-num">{s.openOver7d || <span className="admin-meta">0</span>}</td>
    </>
  );
}
