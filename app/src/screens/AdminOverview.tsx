import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useT } from '../i18n';
import { adminHealth, type AdminHealth, type AdminOverview as Overview } from '../api/admin';
import { Dot, When, abs } from './adminUtil';

/**
 * Overview tab — the "what's going on / what needs me" page. Banner + engine, today's numbers, queue counts,
 * the last 10 events, and a needs-attention list built from the queue + sync + canary. Everything links onward.
 */
export default function AdminOverview({ queue, go }: { queue: Overview | null; go: (hash: string) => void }) {
  const t = useT();
  const [h, setH] = useState<AdminHealth | null>(null);
  const [err, setErr] = useState(false);
  const load = useCallback(async () => { try { setH(await adminHealth(10)); setErr(false); } catch { setErr(true); } }, []);
  useEffect(() => {
    void load();
    const tick = () => { if (document.visibilityState === 'visible') void load(); };
    const iv = window.setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(iv); document.removeEventListener('visibilitychange', tick); };
  }, [load]);

  if (!h) return err ? <div className="notice notice-error" role="alert">{t('admin.loadError')} <button type="button" className="btn btn-ghost" onClick={load}>{t('account.retry')}</button></div> : <p className="muted" aria-busy="true">{t('account.loading')}</p>;

  const bad = h.subsystems.filter((s) => s.status === 'error' || s.status === 'warn');
  const drift = (h.canary?.categories ?? []).filter((c) => c.drifted);
  const needs: { key: string; text: string; hash: string; level: 'error' | 'warn' | 'ok' }[] = [];
  if (queue?.awaitingReview.length) needs.push({ key: 'awaiting', text: t('admin.ov.needs.awaiting', { n: queue.awaitingReview.length }), hash: '#queue', level: 'warn' });
  if (queue?.failed.length) needs.push({ key: 'failed', text: t('admin.ov.needs.failed', { n: queue.failed.length }), hash: '#queue', level: 'error' });
  if (h.engine.paused) needs.push({ key: 'paused', text: t('admin.ov.needs.paused'), hash: '#system', level: 'error' });
  if (h.sync.caseIdPending > 0) needs.push({ key: 'caseids', text: t('admin.ov.needs.caseIds', { n: h.sync.caseIdPending, when: h.sync.caseIdPendingOldestAt ? abs(h.sync.caseIdPendingOldestAt) : '' }), hash: '#portal', level: 'warn' });
  if (drift.length) needs.push({ key: 'drift', text: t('admin.ov.needs.drift', { cats: drift.map((c) => c.category).join(', ') }), hash: '#portal', level: 'error' });
  for (const s of bad) needs.push({ key: s.key, text: t('admin.ov.needs.subsystem', { label: s.label, err: s.lastError ?? '' }), hash: '#system', level: s.status === 'error' ? 'error' : 'warn' });

  return (
    <div className="admin-overview">
      <div className={`card sys-banner is-${h.overall}`} role="status">
        <Dot status={h.overall} />
        <strong>{t(`admin.sys.overall.${h.overall}`)}</strong>
        <span>{h.engine.paused ? t('admin.engine.paused') : t('admin.engine.running')}</span>
        <span className="admin-meta">{t('admin.engine.hour', { n: h.engine.submissionsThisHour })} · {t('admin.engine.failures', { n: h.engine.consecutiveFailures })} · {t('admin.engine.mode', { mode: h.engine.hitlMode, n: h.engine.accountTrustN })}</span>
        <span className="sys-time" title={abs(h.generatedAt)}>{t('admin.sys.generated', { when: abs(h.generatedAt) })}</span>
        <button type="button" className="btn btn-ghost" onClick={load}>{t('admin.refresh')}</button>
      </div>

      <div className="admin-ov-grid">
        <section className="admin-section">
          <h2>{t('admin.ov.needs')} <span className="admin-count">{needs.length}</span></h2>
          {needs.length === 0 ? <p className="card admin-ov-calm"><Dot status="ok" /> {t('admin.ov.calm')}</p> : (
            <ul className="admin-ov-needs">
              {needs.map((n) => <li key={n.key} className={`card is-${n.level}`}><Dot status={n.level} /><span>{n.text}</span><button type="button" className="btn btn-ghost admin-tbl-btn" onClick={() => go(n.hash)}>{t('admin.ov.open')}</button></li>)}
            </ul>
          )}
        </section>

        <section className="admin-section">
          <h2>{t('admin.ov.queue')}</h2>
          <div className="sys-numbers">
            {(['awaiting_review', 'pending', 'processing', 'failed'] as const).map((k) => <button key={k} type="button" className="card sys-num admin-num-btn" onClick={() => go('#queue')}><b>{h.counts[k] ?? 0}</b><span>{t(`admin.sys.count.${k}`)}</span></button>)}
            {(['submitted', 'rejected', 'auto-rejected'] as const).map((k) => <button key={k} type="button" className="card sys-num admin-num-btn" onClick={() => go(`#reports?status=${k}`)}><b>{h.counts[k] ?? 0}</b><span>{t(`admin.sys.count.${k}`)}</span></button>)}
          </div>
          <h2>{t('admin.ov.today')}</h2>
          <div className="sys-numbers">
            <div className="card sys-num"><b>{h.engine.submissionsThisHour}</b><span>{t('admin.sys.thisHour')}</span></div>
            <div className="card sys-num"><b><When iso={h.engine.lastSubmissionTime} t={t} /></b><span>{t('admin.sys.lastSent')}</span></div>
            <div className="card sys-num"><b>{h.ai.intakeToday} / {h.ai.dailyCap}</b><span>{t('admin.sys.ai')}</span></div>
            <div className="card sys-num"><b>{h.users}</b><span>{t('admin.sys.users')}</span></div>
            <div className="card sys-num"><b>{h.cityFeed.items}</b><span>{t('admin.sys.cityFeed', { when: h.cityFeed.fetchedAt ? abs(h.cityFeed.fetchedAt) : t('admin.sys.never') })}</span></div>
            <div className="card sys-num"><b>{h.subsystems.reduce((n, s) => n + s.errToday, 0)}</b><span>{t('admin.ov.errorsToday')}</span></div>
          </div>
        </section>
      </div>

      <section className="admin-section">
        <h2>{t('admin.ov.subsystems')}</h2>
        <div className="admin-ov-lights">
          {h.subsystems.map((s) => <button key={s.key} type="button" className={`chip admin-light admin-light--${s.status}`} onClick={() => go('#system')} title={`${s.what} · ${t('admin.sys.lastOk', { when: s.lastOkAt ? abs(s.lastOkAt) : t('admin.sys.never') })}`}><Dot status={s.status} /> {s.label}</button>)}
        </div>
      </section>

      <section className="admin-section">
        <h2>{t('admin.ov.events')} <button type="button" className="btn btn-ghost admin-tbl-btn" onClick={() => go('#events')}>{t('admin.ov.allEvents')}</button></h2>
        {h.events.length === 0 ? <p className="admin-empty">{t('admin.bucket.empty')}</p> : (
          <table className="admin-table sys-events-table">
            <thead><tr><th scope="col">{t('admin.sys.col.time')}</th><th scope="col">{t('admin.sys.col.level')}</th><th scope="col">{t('admin.sys.col.kind')}</th><th scope="col">{t('admin.sys.col.message')}</th><th scope="col">{t('admin.sys.col.report')}</th></tr></thead>
            <tbody>{h.events.slice(0, 10).map((e) => (
              <tr key={e.id} className={`sys-event sys-event--${e.level}`}>
                <td className="sys-time" title={abs(e.at)}><When iso={e.at} t={t} /></td>
                <td><Dot status={e.level === 'info' ? 'ok' : e.level} /> <span className="admin-meta">{e.level}</span></td>
                <td><span className="sys-kind">{e.kind}</span></td>
                <td className="sys-msg">{e.msg}</td>
                <td>{e.reportId && <Link to={`/r/${e.reportId}`} target="_blank" className="sys-time" title={e.reportId}>{e.reportId.slice(0, 10)}…</Link>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
      <p className="admin-meta">{t('admin.ov.learn')} <a href="#explain:pipeline">{t('admin.ov.learnLink')}</a></p>
    </div>
  );
}
