import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { attachEmail, followReport, getReport } from '../api/client';
import { listMyReports } from '../lib/myReports';
import { ApiError, type ReportView } from '../api/types';
import { BRAND } from '../brand';
import { useT } from '../i18n';
import CategoryIcon from '../components/CategoryIcon';
import './Track.css';

type Tone = 'progress' | 'ok' | 'warn';
interface StatusInfo { headline: string; tone: Tone; explainer?: string; portalLink?: boolean; }

function isTerminal(v: ReportView): boolean {
  if (v.status === 'rejected') return true;
  if (v.status === 'sent' && (v.portalStatus === 'Resolved' || v.portalStatus === 'Cancelled')) return true;
  return false;
}

function statusInfo(v: ReportView, t: (k: string) => string): StatusInfo {
  switch (v.status) {
    case 'rejected': return { headline: t('track.state.needsAttention'), tone: 'warn', explainer: t('track.state.rejected') };
    case 'failed':
    case 'needs_attention': return { headline: t('track.state.needsAttention'), tone: 'warn', explainer: t('track.state.failed') };
    case 'received': return { headline: t('track.state.received'), tone: 'progress' };
    case 'awaiting_review':
    case 'sending': return { headline: t('track.state.sending'), tone: 'progress' };
    case 'sent':
      switch (v.portalStatus) {
        case 'Submitted': return { headline: t('track.state.citySubmitted'), tone: 'progress' };
        case 'Assigned': return { headline: t('track.state.cityAssigned'), tone: 'progress' };
        case 'Resolved': return { headline: t('track.state.cityResolved'), tone: 'ok' };
        case 'Cancelled': return { headline: t('track.state.cityCancelled'), tone: 'warn', explainer: t('track.state.cityCancelledBody'), portalLink: true };
        default: return { headline: t('track.state.sent'), tone: 'ok' };
      }
    default: return { headline: t('track.state.received'), tone: 'progress' };
  }
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

  const info = statusInfo(view, t);
  const trackUrl = `${BRAND.siteUrl}/r/${id}`;
  const ts = (iso: string | null) => (iso ? new Date(iso).getTime() || 0 : 0);
  const entries = [...view.timeline].sort((a, b) => ts(b.at) - ts(a.at));

  return (
    <section className="track section">
      {justSubmitted && <ConfirmHeader trackUrl={trackUrl} />}

      <div className={`track-status card track-status--${info.tone}`} aria-live="polite">
        <span className="label">{t('track.status.label')}</span>
        <h2 className="track-status-headline">{info.headline}</h2>
        {view.portalCaseId && (
          <span className="track-case" aria-label={`${t('track.caseId.label')} ${view.portalCaseId}`}>
            <span className="track-case-label">{t('track.caseId.label')}</span>{view.portalCaseId}
          </span>
        )}
        {info.explainer && <p className="track-status-explainer">{info.explainer}</p>}
        {info.portalLink && (
          <a className="track-portal-link" href={BRAND.portalUrl} target="_blank" rel="noopener">{t('track.portalLink')}</a>
        )}
      </div>

      <div className="section">
        <h2>{t('track.timeline.title')}</h2>
        <ol className="track-timeline">
          {entries.map((e, i) => (
            <li key={`${e.at}-${i}`} className={`track-tl-row${i === 0 ? ' is-current' : ''}`}>
              <span className="track-tl-dot" aria-hidden="true" />
              <div className="track-tl-body">
                <span className="track-tl-label">{e.label}</span>
                <span className="track-tl-time">
                  <time dateTime={e.at ?? undefined}>{relTime(e.at, t('track.time.justNow'))}</time>
                  <span className="track-tl-abs"> · {absTime(e.at)}</span>
                </span>
              </div>
            </li>
          ))}
        </ol>
        {view.nextUpdateHint && <p className="hint">{view.nextUpdateHint}</p>}
      </div>

      <div className="section">
        <h2>{t('track.details.title')}</h2>
        <div className="card track-details">
          {view.photoUrl && <img className="track-photo" src={view.photoUrl} alt={t('track.details.photoAlt')} />}
          <div className="track-cat">
            <span className="track-cat-icon"><CategoryIcon k={view.category} size={22} /></span>
            <span className="track-cat-label">{view.categoryLabel}</span>
          </div>
          <div className="track-map" data-map data-lat={view.lat ?? undefined} data-lng={view.lng ?? undefined}>
            <span className="label">{t('track.map.label')}</span>
            <p className="track-map-addr">{view.address}</p>
            {view.lat != null && view.lng != null && (
              <p className="muted track-map-coords">{view.lat.toFixed(5)}, {view.lng.toFixed(5)}</p>
            )}
          </div>
        </div>
      </div>

      <div className="section">
        <h2>{t('track.expect.title')}</h2>
        <ul className="track-expect">
          <li>{t('track.expect.body1')}</li>
          <li>{t('track.expect.body2')}</li>
          <li>{t('track.expect.body3')}</li>
        </ul>
      </div>

      <EmailAttach id={id!} hasEmail={view.hasEmail === true} mine={listMyReports().some((r) => r.id === id)} />
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

// Reporter (this device sent it) → attach email. Anyone else → follow it.
function EmailAttach({ id, hasEmail, mine }: { id: string; hasEmail: boolean; mine: boolean }) {
  const t = useT();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true); setError(false);
    try {
      if (mine) await attachEmail(id, email.trim()); else await followReport(id, email.trim());
      setDone(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="section">
      <h2>{t(mine ? 'track.email.title' : 'track.follow.title')}</h2>
      {(hasEmail && mine) || done ? (
        <div className="notice notice-ok" role="status">{t(done ? (mine ? 'track.email.done' : 'track.follow.done') : 'track.email.hasEmail')}</div>
      ) : (
        <form className="track-email" onSubmit={onSubmit} noValidate>
          <label className="label" htmlFor="track-email">{t('track.email.label')}</label>
          <input id="track-email" className="input" type="email" inputMode="email" autoComplete="email"
            placeholder={t('track.email.placeholder')} value={email} onChange={(e) => setEmail(e.target.value)} />
          <p className="hint">{t(mine ? 'track.email.consent' : 'track.follow.consent')}</p>
          <button type="submit" className="btn btn-secondary" disabled={!email.trim() || busy}>{busy ? t('track.email.sending') : t(mine ? 'track.email.submit' : 'track.follow.submit')}</button>
          {error && <div className="notice notice-error" role="alert">{t('track.email.error')}</div>}
        </form>
      )}
    </div>
  );
}
