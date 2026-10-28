import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { getReport } from '../api/client';
import { ApiError, type ReportView, type TimelineEntry } from '../api/types';
import { BRAND } from '../brand';
import { useT } from '../i18n';
import CategoryIcon from '../components/CategoryIcon';
import { neighborhoodAt } from '../lib/neighborhoods';
import { shortLabel } from '../lib/categories';
import OwnerActions from '../components/OwnerActions';
import CityAskCard from '../components/CityAskCard';
import TrackNear from '../components/TrackNear';
import { track } from '../lib/analytics';
import './Track.css';

type Tone = 'progress' | 'ok' | 'closed' | 'warn';
interface StatusInfo { headline: string; tone: Tone; explainer?: string; portalLink?: boolean; }

function isTerminal(v: ReportView): boolean {
  if (v.status === 'rejected') return true;
  if (v.status === 'sent' && (v.portalStatus === 'Resolved' || v.portalStatus === 'Cancelled' || v.portalStatus === 'Merged')) return true;
  return false;
}

function statusInfo(v: ReportView, t: (k: string) => string): StatusInfo {
  switch (v.status) {
    case 'rejected': return v.cancelledByReporter
      ? { headline: t('track.state.cancelledByYou'), tone: 'warn' }
      : { headline: t('track.state.needsAttention'), tone: 'warn', explainer: t('track.state.rejected') };
    case 'failed':
    case 'needs_attention': return { headline: t('track.state.needsAttention'), tone: 'warn', explainer: t('track.state.failed') };
    case 'received': return { headline: t('track.state.received'), tone: 'progress' };
    case 'awaiting_review':
    case 'sending': return { headline: t('track.state.sending'), tone: 'progress' };
    case 'sent':
      switch (v.portalStatus) {
        case 'Submitted': return { headline: t('track.state.citySubmitted'), tone: 'progress' };
        case 'Assigned': return { headline: t('track.state.cityAssigned'), tone: 'progress' };
        case 'In Progress': return { headline: t('track.state.cityInProgress'), tone: 'progress' };
        case 'Department Responded': return { headline: t('track.state.cityDeptResponded'), tone: 'progress' };
        case 'Resolved': return { headline: t('track.state.cityResolved'), tone: 'closed' };
        case 'Cancelled': return { headline: t('track.state.cityCancelled'), tone: 'warn', explainer: t('track.state.cityCancelledBody'), portalLink: true };
        case 'Merged': return { headline: t('track.state.cityMerged'), tone: 'closed', explainer: t('track.state.cityMergedBody'), portalLink: true };
        default: return { headline: t('track.state.sent'), tone: 'ok' };
      }
    default: return { headline: t('track.state.received'), tone: 'progress' };
  }
}

type RailKind = 'cancelled' | 'notfiled' | 'normal';

/** Parcel-style rail: Received → Sent to city → City working → Closed by the city (the city's "Resolved"). `done` = steps completed;
 *  `branch` marks a warn ending. Not-filed / cancelled rails end at the failure — no steps ahead. */
function buildRail(v: ReportView, t: (k: string) => string, kind: RailKind): { labels: string[]; done: number; branch: 'closed' | 'warn' | null } {
  if (kind === 'cancelled') return { labels: [t('track.rail.received'), t('track.rail.cancelled')], done: 1, branch: 'warn' };
  if (kind === 'notfiled') return { labels: [t('track.rail.received'), t('track.rail.notFiled')], done: 1, branch: 'warn' };
  const labels = [t('track.rail.received'), t('track.rail.sent'), t('track.rail.working'), t('track.rail.resolved')];
  if (v.status === 'sent') {
    switch (v.portalStatus) {
      case 'Assigned':
      case 'In Progress':
      case 'Department Responded': return { labels, done: 3, branch: null };
      case 'Resolved': return { labels, done: 4, branch: null };
      case 'Cancelled': labels[3] = t('track.rail.closed'); return { labels, done: 3, branch: 'closed' };
      case 'Merged': labels[3] = t('track.rail.merged'); return { labels, done: 4, branch: null };
      default: return { labels, done: 2, branch: null };
    }
  }
  return { labels, done: 1, branch: null };
}

/** The city's work-order status in the active language when we know the word; the city's own word otherwise. */
function workOrderStatus(status: string, t: (k: string) => string): string {
  const k = `track.workOrder.status.${status}`;
  const v = t(k);
  return v === k ? status : v;
}

/** Rows the server marks with a `kind` are worded here; the rest arrive as English labels (localized below, raw as fallback). */
function timelineLabel(e: TimelineEntry, mine: boolean, t: (k: string, vars?: Record<string, string | number>) => string): string {
  switch (e.kind) {
    case 'city_receipt': return t('track.timeline.cityReceipt');
    case 'city_routed': return e.vars?.dept ? t('track.timeline.cityRouted', { dept: e.vars.dept }) : t('track.timeline.cityRoutedBare');
    case 'city_ask': return t('track.timeline.cityAsk');
    case 'city_answer': return mine ? t('track.timeline.youAnswered') : t('track.timeline.answerSent');
    case 'work_order': {
      const number = e.vars?.number ?? '';
      const status = e.vars?.status ? workOrderStatus(e.vars.status, t) : '';
      return status ? t(number ? 'track.timeline.workOrder' : 'track.timeline.workOrderNoNumber', { number, status }) : t('track.timeline.workOrderCreated', { number });
    }
    default: return localizeTimelineLabel(e.label, t);
  }
}

/** Server timeline labels arrive in English; render them in the active language, raw label as fallback. */
function localizeTimelineLabel(label: string, t: (k: string, vars?: Record<string, string | number>) => string): string {
  const exact: Record<string, string> = {
    'Received': 'track.timeline.received',
    'Not filed': 'track.timeline.notFiled',
    'Needs attention — we are looking at it': 'track.timeline.needsAttention',
  };
  if (exact[label]) return t(exact[label]);
  const filed = label.match(/^Filed with the city as (.+)$/);
  if (filed) return t('track.timeline.filedAs', { case: filed[1] });
  const msg = label.match(/^Message from the city(?:: (.+))?$/);
  if (msg) return msg[1] ? t('track.timeline.cityMessage', { subject: msg[1] }) : t('track.timeline.cityMessageBare');
  const city = label.match(/^City status: (.+)$/);
  if (city) {
    const localized = t(`track.portalStatus.${city[1]}`);
    return t('track.timeline.cityStatus', { status: localized.startsWith('track.') ? city[1] : localized });
  }
  return label;
}

const REL_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000], ['month', 2_592_000], ['week', 604_800], ['day', 86_400], ['hour', 3_600], ['minute', 60],
];
function relTime(iso: string | null | undefined, justNow: string): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const sec = Math.round((then - Date.now()) / 1000);
  if (Math.abs(sec) < 45) return justNow;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, s] of REL_UNITS) if (Math.abs(sec) >= s) return rtf.format(Math.round(sec / s), unit);
  return rtf.format(Math.round(sec / 60), 'minute');
}
function absTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

type LoadState = 'loading' | 'loaded' | 'notfound' | 'error';

export default function Track() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const t = useT();

  const justSubmitted = (location.state as { justSubmitted?: boolean } | null)?.justSubmitted === true
    || searchParams.get('submitted') === '1';

  const [view, setView] = useState<ReportView | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [hood, setHood] = useState<string | null>(null);
  useEffect(() => {
    if (view?.lat == null || view?.lng == null) { setHood(null); return; }
    let cancelled = false;
    neighborhoodAt(view.lat, view.lng).then((h) => { if (!cancelled) setHood(h); }).catch(() => {});
    return () => { cancelled = true; };
  }, [view?.lat, view?.lng]);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!id) { setLoadState('notfound'); return; }
    if (!opts?.silent) setLoadState('loading');
    try {
      const v = await getReport(id);
      setView(v);
      setLoadState('loaded');
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setLoadState('notfound');
      else if (!opts?.silent) setLoadState('error');
      // silent poll failures keep the last-good view on screen
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const terminal = view ? isTerminal(view) : false;
  useEffect(() => {
    if (loadState !== 'loaded' || terminal) return;
    const poll = () => { if (document.visibilityState === 'visible') load({ silent: true }); };
    const iv = window.setInterval(poll, 60_000);
    document.addEventListener('visibilitychange', poll);
    return () => { window.clearInterval(iv); document.removeEventListener('visibilitychange', poll); };
  }, [loadState, terminal, load]);

  if (loadState === 'loading') {
    return (
      <section className="track section" aria-busy="true">
        <p className="visually-hidden" aria-live="polite">{t('track.loading')}</p>
        <div className="track-skeleton card" aria-hidden="true">
          <div className="sk-line sk-lg" /><div className="sk-line" /><div className="sk-line sk-sm" />
        </div>
      </section>
    );
  }

  if (loadState === 'notfound') {
    return (
      <section className="track section">
        <h1 className="track-h1">{t('track.notFound.title')}</h1>
        <p className="muted">{t('track.notFound.body')}</p>
        <Link className="btn btn-primary track-block-btn" to="/">{t('track.notFound.home')}</Link>
      </section>
    );
  }

  if (loadState === 'error' || !view) {
    return (
      <section className="track section">
        <div className="notice notice-error" role="alert">{t('track.error.body')}</div>
        <button type="button" className="btn btn-primary track-block-btn" onClick={() => load()}>{t('track.error.retry')}</button>
      </section>
    );
  }

  const cancelled = view.cancelledByReporter === true || view.notFiled?.code === 'cancelled';
  const nf = !cancelled
    ? (view.notFiled ?? (view.status === 'rejected' ? { code: 'other', text: '', duplicateOf: null } : null))
    : null;
  const notFiled = nf !== null;
  const kind: RailKind = cancelled ? 'cancelled' : notFiled ? 'notfiled' : 'normal';
  const info = statusInfo(view, t);
  // The city is waiting on the reporter: that is the status that matters until they answer.
  const askOpen = !cancelled && !notFiled && view.cityAsk?.open === true;
  const headline = cancelled ? t('track.state.cancelledByYou') : notFiled ? t('track.notfiled.heading')
    : askOpen ? t(view.mine ? 'track.state.askOwner' : 'track.state.askPublic') : info.headline;
  const tone: Tone = cancelled || notFiled || askOpen ? 'warn' : info.tone;
  const wo = !cancelled && !notFiled ? view.workOrder ?? null : null;
  const dept = !cancelled && !notFiled ? view.department ?? null : null;
  const rail = buildRail(view, t, kind);
  const trackUrl = `${BRAND.siteUrl}/r/${id}`;
  const ts = (iso: string | null) => (iso ? new Date(iso).getTime() || 0 : 0);
  const entries = [...view.timeline].sort((a, b) => ts(b.at) - ts(a.at));

  return (
    <section className="track section">
      {justSubmitted && view.status !== 'rejected' && <ConfirmHeader trackUrl={trackUrl} />}

      <div className={`track-status ticket track-status--${tone}`} aria-live="polite">
        <div className="ticket-head">
          <span className="label">{t('track.status.label')}</span>
          {view.portalCaseId && !cancelled && !notFiled && (
            <span className="track-case" aria-label={`${t('track.caseId.label')} ${view.portalCaseId}`}>
              <span className="track-case-label">{t('track.caseId.label')}</span>{view.portalCaseId}
            </span>
          )}
        </div>
        <h2 className="track-status-headline">{headline}</h2>
        {view.resolutionMessage && !notFiled && !cancelled && (
          <div className="track-city-note">
            <p className="track-city-note-label">{t('track.cityNote.label')}</p>
            <blockquote className="track-city-note-text">{view.resolutionMessage}</blockquote>
          </div>
        )}
        {(dept || wo) && (
          <dl className="track-facts">
            {dept && (<><dt>{t('track.facts.department')}</dt><dd>{dept}</dd></>)}
            {wo && (
              <>
                <dt>{t('track.facts.workOrder')}</dt>
                <dd>
                  {wo.number && <span className="track-facts-num">#{wo.number}</span>}
                  {wo.status && <span>{wo.number ? ' · ' : ''}{workOrderStatus(wo.status, t)}</span>}
                  {wo.completedAt && /complete/i.test(wo.status) && <span className="track-facts-when"> · {absTime(wo.completedAt)}</span>}
                </dd>
              </>
            )}
          </dl>
        )}
        {wo && /complete/i.test(wo.status) && view.status === 'sent' && !isTerminal(view) && (
          <p className="track-status-explainer">{t('track.facts.workOrderDoneOpen')}</p>
        )}
        {notFiled && nf ? (
          <NotFiledBody nf={nf} t={t} />
        ) : cancelled ? null : (
          <>
            {info.explainer && <p className="track-status-explainer">{info.explainer}</p>}
            {info.portalLink && (
              <a className="track-portal-link" href={BRAND.portalUrl} target="_blank" rel="noopener">{t('track.portalLink')}</a>
            )}
          </>
        )}
        <ol className={`rail rail--${rail.branch ?? 'ok'}`} style={{ gridTemplateColumns: `repeat(${rail.labels.length}, 1fr)` }} aria-label={t('track.timeline.title')}>
          {rail.labels.map((label, i) => {
            const state = i < rail.done ? 'done' : i === rail.done && rail.branch ? 'warn' : i === rail.done ? 'active' : 'todo';
            return (
              <li key={i} className={`rail-step rail-step--${state}`} style={{ animationDelay: `${i * 60}ms` }} aria-current={state === 'active' ? 'step' : undefined}>
                <span className="rail-dot" aria-hidden="true">
                  {state === 'done' && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>}
                  {state === 'warn' && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round"><path d="M12 5v8" /><circle cx="12" cy="18.5" r="1.8" fill="currentColor" stroke="none" /></svg>}
                </span>
                <span className="rail-label">{label}</span>
              </li>
            );
          })}
        </ol>
        {view.nextUpdateHint && !notFiled && !cancelled && <p className="ticket-eta">{view.nextUpdateHint}</p>}
      </div>

      {!notFiled && !cancelled && <CityAskCard id={id!} view={view} onChange={() => load({ silent: true })} />}

      <div className="section">
        <h2>{t('track.timeline.title')}</h2>
        <ol className="track-timeline">
          {entries.map((e, i) => (
            <li key={`${e.at}-${i}`} className={`track-tl-row${i === 0 ? ' is-current' : ''}`}>
              <span className="track-tl-dot" aria-hidden="true" />
              <div className="track-tl-body">
                {e.text ? (
                  <details className="track-tl-msg">
                    <summary className="track-tl-label">{timelineLabel(e, view.mine === true, t)}</summary>
                    <div className="track-tl-msg-text">{e.text}</div>
                  </details>
                ) : (
                  <span className="track-tl-label">{timelineLabel(e, view.mine === true, t)}</span>
                )}
                <span className="track-tl-time">
                  <time dateTime={e.at ?? undefined}>{relTime(e.at, t('track.time.justNow'))}</time>
                  <span className="track-tl-abs"> · {absTime(e.at)}</span>
                </span>
              </div>
            </li>
          ))}
        </ol>
      </div>

      <div className="section">
        <h2>{t('track.details.title')}</h2>
        <div className="card track-details">
          {view.photoUrl && <div className="track-photo-frame"><img className="track-photo" src={view.photoUrl} alt={t('track.details.photoAlt')} /></div>}
          <div className="track-cat">
            <span className="track-cat-icon"><CategoryIcon k={view.category} size={40} /></span>
            <span className="track-cat-label">{shortLabel(view.category, t)}</span>
          </div>
          <div className="track-map" data-map data-lat={view.lat ?? undefined} data-lng={view.lng ?? undefined}>
            <span className="label">{t('track.map.label')}</span>
            <p className="track-map-addr">{view.address}</p>
            {hood && <span className="track-hood">{hood}</span>}
            {view.lat != null && view.lng != null && (
              <p className="muted track-map-coords">{view.lat.toFixed(5)}, {view.lng.toFixed(5)}</p>
            )}
          </div>
        </div>
      </div>

      {/* How many of the city's cases are open around this spot, and the map: the moment right after filing is when the street matters most. */}
      {view.lat != null && view.lng != null && <TrackNear id={id!} view={view} />}

      {notFiled || cancelled ? (
        <div className="section">
          <h2>{t('track.notfiled.expect.title')}</h2>
          <ul className="track-expect">
            <li>{t('track.notfiled.noCaseNumber')}</li>
            <li>{t('track.notfiled.notPublic')}</li>
          </ul>
        </div>
      ) : (
        <div className="section">
          <h2>{t('track.expect.title')}</h2>
          <ul className="track-expect">
            <li>{t('track.expect.body1')}</li>
            <li>{t('track.expect.body2')}</li>
            <li>{t('track.expect.body3')}</li>
          </ul>
        </div>
      )}

      <OwnerActions id={id!} view={view} onChange={() => load({ silent: true })} />
    </section>
  );
}

function ConfirmHeader({ trackUrl }: { trackUrl: string }) {
  const t = useT();
  const linkRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [canShare, setCanShare] = useState(false);

  useEffect(() => { setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function'); }, []);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(trackUrl);
      track('share', { method: 'copy' });
      setCopied(true); window.setTimeout(() => setCopied(false), 2000);
    } catch {
      const el = linkRef.current;
      if (el) {
        el.focus(); el.select();
        try { document.execCommand('copy'); setCopied(true); window.setTimeout(() => setCopied(false), 2000); } catch { /* ignore */ }
      }
    }
  }, [trackUrl]);

  const share = useCallback(() => {
    if (typeof navigator.share !== 'function') return;
    track('share', { method: 'native' });
    navigator.share({ title: BRAND.name, text: t('track.share.text'), url: trackUrl }).catch(() => { /* dismissed */ });
  }, [t, trackUrl]);

  return (
    <div className="track-confirm">
      <div className="track-check" aria-hidden="true">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
      </div>
      <h1 className="track-h1">{t('track.confirm.title')}</h1>
      <p className="muted track-confirm-sub">{t('track.confirm.sub')}</p>

      <label className="label" htmlFor="track-link">{t('track.confirm.linkLabel')}</label>
      <div className="track-link-row">
        <input id="track-link" ref={linkRef} className="input track-link-input" readOnly value={trackUrl}
          onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="btn btn-secondary track-copy" onClick={copy}>
          {copied ? t('track.confirm.copied') : t('track.confirm.copy')}
        </button>
      </div>

      <div className="track-confirm-actions">
        {canShare && <button type="button" className="btn btn-secondary" onClick={share}>{t('track.confirm.share')}</button>}
        <Link className="btn btn-ghost" to="/">{t('track.confirm.another')}</Link>
      </div>
      <p className="hint">{t('track.confirm.a2hs')}</p>
    </div>
  );
}

/** Not-filed reason + next step. Bucket the code: duplicate (view + report anyway),
 *  failed (a person is looking at it), everything else (report again with photo + location). */
function NotFiledBody({ nf, t }: { nf: { code: string; text: string; duplicateOf?: string | null }; t: (k: string, vars?: Record<string, string | number>) => string }) {
  const bucket = nf.code === 'duplicate' ? 'duplicate' : nf.code === 'failed' ? 'failed' : 'again';
  const reason = nf.text?.trim()
    ? nf.text.trim()
    : bucket === 'duplicate' ? t('track.notfiled.reason.duplicate')
    : bucket === 'again' ? t('track.notfiled.reason.again')
    : '';
  return (
    <>
      {reason && <p className="track-status-explainer">{reason}</p>}
      <div className="track-notfiled-actions">
        {bucket === 'duplicate' && (
          <>
            {nf.duplicateOf && <Link className="btn btn-secondary" to={`/r/${nf.duplicateOf}`}>{t('track.notfiled.duplicate.view')}</Link>}
            <Link className="btn btn-ghost" to="/">{t('track.notfiled.duplicate.again')}</Link>
          </>
        )}
        {bucket === 'again' && <Link className="btn btn-secondary" to="/">{t('track.notfiled.reportAgain')}</Link>}
        {bucket === 'failed' && <p className="track-notfiled-note">{t('track.notfiled.failed')}</p>}
      </div>
    </>
  );
}

// Reporter (this device sent it) → attach email. Anyone else → follow it.
