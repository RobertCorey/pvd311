import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getWeek, resetWeekCache, WEEK_OUTCOMES, type WeekNotable, type WeekSummary } from '../api/week';
import { getMe, updateMe, type Me } from '../api/me';
import { ApiError } from '../api/types';
import { useSession } from '../lib/auth';
import { track } from '../lib/analytics';
import { useI18n } from '../i18n';
import { groupOf } from '../lib/categories';
import { agoText } from '../components/StreetRow';
import CategoryIcon from '../components/CategoryIcon';
import Illustration from '../components/Illustration';
import '../components/StreetParts.css';
import './Week.css';

/** /week — "This week in Providence" (Rob, 2026-10-25: "make the app more something you'd want to check in on").
 *  A plain scrolling page anyone can open and share: 7 days of the city's public 311 list against the 7 before
 *  (GET /api/week), every section a door into /street (type → ?g=, neighborhood → ?n=, a close → ?case=), and the
 *  Monday 'week_digest' opt-in (prefs.weekDigest). Ember & Harbor: ink on paper, numbers in Bricolage, the outcome
 *  bar carries the admin insights' validated palette and every share is also written out in text.
 *
 *  Stable links (2026-10-26): `/week?until=YYYY-MM-DD` is the week ending at the end of that Providence day, so a
 *  Monday Reddit post still means the same week on Thursday. Share always copies the dated url (the Worker names
 *  it in `untilDate`); a past week is titled by its range and gets ‹ Previous · Next › · Latest week links. */

/** Providence's clock for the range and the busiest day — the Worker computes both in America/New_York. */
const TZ = 'America/New_York';
const HOODS_SHOWN = 8;
const FLASH_MS = 2500;
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Today's calendar date in Providence (en-CA formats ISO-style) — decides a dated title before the numbers arrive. */
const todayNY = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
/** A YYYY-MM-DD plus n days, as YYYY-MM-DD (calendar arithmetic in UTC, so no zone can shift the day). */
const addDays = (ymd: string, n: number): string => {
  const m = YMD.exec(ymd);
  if (!m) return ymd;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n)).toISOString().slice(0, 10);
};

export default function Week() {
  const { t, lang } = useI18n();
  const session = useSession();
  const locale = lang === 'es' ? 'es' : 'en-US';
  const num = (n: number) => n.toLocaleString(locale);
  const [params] = useSearchParams();
  /** The week asked for: null = the current week. Validity is the Worker's call (400 → the error state). */
  const until = params.get('until') || null;

  /* ── Data ─────────────────────────────────────────────────────────────────────────────────────── */
  const [data, setData] = useState<WeekSummary | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    let live = true;
    setData(null); setState('loading'); setErrorCode(null);
    getWeek(until).then((d) => { if (!live) return; setData(d); setNowMs(Date.now()); setState('ok'); track('week_view', { total: d.total, current: d.current }); })
      .catch((e: unknown) => { if (live) { setErrorCode(e instanceof ApiError ? e.code : null); setState('error'); } });
    return () => { live = false; };
  }, [tick, until]);
  const retry = () => { resetWeekCache(); setTick((x) => x + 1); };

  /* ── Formatting ───────────────────────────────────────────────────────────────────────────────── */
  const day = (iso: string) => { const ms = Date.parse(iso); return Number.isFinite(ms) ? new Date(ms).toLocaleDateString(locale, { month: 'short', day: 'numeric', timeZone: TZ }) : ''; };
  /** "YYYY-MM-DD" (already a Providence calendar day) formatted as a date, e.g. "Wednesday, Oct 21" or "Oct 21". */
  const fromYmd = (ymd: string, opts: Intl.DateTimeFormatOptions) => {
    const m = YMD.exec(ymd);
    if (!m) return ymd;
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)).toLocaleDateString(locale, { ...opts, timeZone: 'UTC' });
  };
  const dayName = (ymd: string) => fromYmd(ymd, { weekday: 'long', month: 'short', day: 'numeric' });
  const median = (d: number | null) => (d == null ? '—' : num(Math.round(d * 10) / 10));
  const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);
  const caseHref = (x: WeekNotable) => {
    const p = new URLSearchParams({ case: x.id });
    if (x.lat != null && x.lng != null) { p.set('lat', x.lat.toFixed(5)); p.set('lng', x.lng.toFixed(5)); }
    return `/street?${p}`;
  };
  const delta = (now: number, prev: number) => {
    const d = now - prev;
    const k = d > 0 ? 'up' : d < 0 ? 'down' : 'same';
    return <dd className={`week-delta week-delta--${k}`}><span aria-hidden="true">{d > 0 ? '↑' : d < 0 ? '↓' : '→'} </span>{t(`week.delta.${k}`, { n: num(Math.abs(d)) })}</dd>;
  };

  /* ── Which week this is ───────────────────────────────────────────────────────────────────────── */
  /** The week's end date: the Worker's untilDate once loaded, else the url's (a well-formed past date reads as dated
   *  straight away, so the title does not flip from "This week" after the numbers land). */
  const untilDate = data?.untilDate || (until && YMD.test(until) ? until : null);
  const dated = data ? !data.current : !!(untilDate && untilDate < todayNY());
  const weekFrom = untilDate ? addDays(untilDate, -6) : null;
  const range = untilDate && weekFrom ? `${fromYmd(weekFrom, { month: 'short', day: 'numeric' })} – ${fromYmd(untilDate, { month: 'short', day: 'numeric' })}` : '';
  const title = dated ? t('week.titleOf', { range }) : t('week.title');
  /** The stable link for this week — what Share copies. The sign-in round trip returns here for a past week and to
   *  the live page for the current one. */
  const datedPath = untilDate ? `/week?until=${untilDate}` : '/week';
  const returnPath = dated ? datedPath : '/week';

  /* ── Share ────────────────────────────────────────────────────────────────────────────────────── */
  const [flash, setFlash] = useState('');
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);
  async function share() {
    const href = `${window.location.origin}${datedPath}`;
    track('week_share', { current: !dated });
    try {
      if (typeof navigator.share === 'function') { await navigator.share({ title, url: href }); return; }
      await navigator.clipboard.writeText(href);
      setFlash(t('week.copied'));
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash(''), FLASH_MS);
    } catch { /* cancelled or blocked */ }
  }

  /* ── Monday digest opt-in (prefs.weekDigest), mirroring /street's card ────────────────────────── */
  const [me, setMe] = useState<Me | null>(null);
  const [digest, setDigest] = useState<'idle' | 'saving' | 'error'>('idle');
  useEffect(() => {
    if (!session) { setMe(null); return; }
    let live = true;
    getMe().then((m) => { if (live) setMe(m); }).catch(() => { /* the card still offers the button; a tap PATCHes and loads the account */ });
    return () => { live = false; };
  }, [session]);
  async function setWeekDigest(on: boolean) {
    setDigest('saving');
    try { setMe(await updateMe({ prefs: { weekDigest: on } })); setDigest('idle'); track(on ? 'week_digest_on' : 'week_digest_off'); } catch { setDigest('error'); }
  }
  const digestCard = (
    <div className="card week-digest">
      <h2>{t('week.digest.title')}</h2>
      <p className="muted">{t('week.digest.body')}</p>
      {!session && <Link to={`/account?returnTo=${encodeURIComponent(returnPath)}`} className="btn btn-secondary">{t('week.digest.signIn')}</Link>}
      {session && !me?.prefs.weekDigest && (
        <button type="button" className="btn btn-primary" onClick={() => setWeekDigest(true)} disabled={digest === 'saving'}>{digest === 'saving' ? t('week.digest.saving') : t('week.digest.cta')}</button>
      )}
      {session && me?.prefs.weekDigest && (
        <div className="week-digest-on">
          <p className="notice notice-ok" role="status">{t('week.digest.on')}</p>
          <button type="button" className="btn btn-ghost" onClick={() => setWeekDigest(false)} disabled={digest === 'saving'}>{t('week.digest.off')}</button>
        </div>
      )}
      {digest === 'error' && <p className="hint" role="alert">{t('week.digest.error')}</p>}
    </div>
  );

  /* ── Page ─────────────────────────────────────────────────────────────────────────────────────── */
  /** ‹ Previous week · Next week › · Latest week — only the links that exist; nothing at all on the current week's
   *  first page when it has no previous week (never happens: the floor is 56 days back). */
  const weekNav = (o: { prev: string | null; next: string | null; latest: boolean }) => (o.prev || o.next || o.latest ? (
    <nav className="week-nav" aria-label={t('week.nav')}>
      {o.prev && <Link to={`/week?until=${o.prev}`} className="week-nav-link week-nav-prev"><span aria-hidden="true">‹ </span>{t('week.prev')}</Link>}
      {o.next && <Link to={`/week?until=${o.next}`} className="week-nav-link week-nav-next">{t('week.next')}<span aria-hidden="true"> ›</span></Link>}
      {o.latest && <Link to="/week" className="week-nav-link week-nav-latest">{t('week.latest')}</Link>}
    </nav>
  ) : null);
  const head = (
    <header className="week-head">
      <h1 id="week-title">{title}</h1>
      {data && !dated && <p className="week-range">{t('week.range', { from: day(data.since), to: day(data.until) })}</p>}
      {data && dated && weekFrom && untilDate && <p className="week-range">{t('week.rangeOf', { from: fromYmd(weekFrom, { weekday: 'long' }), to: fromYmd(untilDate, { weekday: 'long' }) })}</p>}
      {data && data.total > 0 && <button type="button" className="btn btn-ghost week-share" onClick={share}>{t('week.share')}</button>}
      {data && weekNav({ prev: data.prevUntil, next: data.nextUntil, latest: !data.current })}
      <p className="week-flash" role="status">{flash}</p>
    </header>
  );

  if (state === 'error' && !data) {
    // A bad or too-old date is not a hiccup: say so and point at the latest week instead of offering Retry.
    const badLink = errorCode === 'too_old' || errorCode === 'invalid_until';
    return (
      <article className="week section" aria-labelledby="week-title">
        {head}
        <div className="notice notice-error week-error" role="alert"><span>{t(errorCode === 'too_old' ? 'week.tooOld' : errorCode === 'invalid_until' ? 'week.badDate' : 'week.error')}</span></div>
        {!badLink && <button type="button" className="btn btn-secondary week-retry" onClick={retry}>{t('week.retry')}</button>}
        {until && weekNav({ prev: null, next: null, latest: true })}
      </article>
    );
  }
  if (!data) {
    return (
      <article className="week section" aria-labelledby="week-title" aria-busy="true">
        {head}
        <p className="week-vh">{t('week.loading')}</p>
        <div className="week-skel" aria-hidden="true"><span className="week-skel-stats"><i /><i /><i /></span><span /><span /><span /></div>
      </article>
    );
  }
  if (data.total === 0) {
    return (
      <article className="week section" aria-labelledby="week-title">
        {head}
        <div className="empty week-quiet">
          <Illustration kind="street" className="illo" />
          <p>{dated && weekFrom && untilDate ? t('week.quietOf', { from: fromYmd(weekFrom, { month: 'short', day: 'numeric' }), to: fromYmd(untilDate, { month: 'short', day: 'numeric' }) }) : t('week.quiet')}</p>
        </div>
        {digestCard}
        <p className="hint week-source">{t('week.source')}</p>
      </article>
    );
  }

  const closedSum = WEEK_OUTCOMES.reduce((a, o) => a + data.outcomes[o], 0);
  const outcomeParts = WEEK_OUTCOMES.filter((o) => data.outcomes[o] > 0);
  const hoods = data.neighborhoods.slice(0, HOODS_SHOWN);
  const hoodMax = hoods.reduce((m, h) => Math.max(m, h.n), 0);

  return (
    <article className="week section" aria-labelledby="week-title">
      {head}

      <dl className="week-stats">
        <div className="card week-stat"><dt>{t('week.stat.requests')}</dt><dd className="week-stat-n">{num(data.total)}</dd>{delta(data.total, data.prev.total)}</div>
        <div className="card week-stat"><dt>{t('week.stat.closed')}</dt><dd className="week-stat-n">{num(data.closed)}</dd>{delta(data.closed, data.prev.closed)}</div>
        <div className="card week-stat"><dt>{t('week.stat.median')}</dt><dd className="week-stat-n">{median(data.medianCloseDays)}</dd></div>
      </dl>

      {data.topTypes.length > 0 && (
        <section aria-labelledby="week-top-h">
          <h2 id="week-top-h" className="week-h">{t('week.top.title')}</h2>
          <ol className="week-list week-top">
            {data.topTypes.map((x) => (
              <li key={`${x.caseType}|${x.category}`}>
                <Link to={`/street?g=${groupOf(x.category) ?? 'other'}`} className="week-row">
                  <span className="street-icon"><CategoryIcon k={x.category} size={24} /></span>
                  <span className="week-row-main">
                    <span className="week-row-name">{x.caseType || t(`street.g.${groupOf(x.category) ?? 'other'}`)}</span>
                    <span className="week-row-sub">{t('week.top.last', { n: num(x.prevN) })}</span>
                  </span>
                  <b className="week-row-n"><span className="week-vh">{t('week.top.thisWeek')} </span>{num(x.n)}</b>
                </Link>
              </li>
            ))}
          </ol>
        </section>
      )}

      {hoods.length > 0 && (
        <section aria-labelledby="week-hoods-h">
          <h2 id="week-hoods-h" className="week-h">{t('week.hoods.title')}</h2>
          <ol className="week-list week-hoods">
            {hoods.map((h) => (
              <li key={h.slug}>
                <Link to={`/street?n=${encodeURIComponent(h.slug)}`} className="week-row week-hood">
                  <span className="week-hood-name">{h.name}</span>
                  <b className="week-row-n">{num(h.n)}</b>
                  <span className="week-hood-bar" aria-hidden="true"><span style={{ width: `${hoodMax ? Math.max(2, Math.round((100 * h.n) / hoodMax)) : 0}%` }} /></span>
                </Link>
              </li>
            ))}
          </ol>
        </section>
      )}

      {closedSum > 0 && (
        <section className="week-outcomes" aria-labelledby="week-outcomes-h">
          <h2 id="week-outcomes-h" className="week-h">{t('week.outcomes.title')}</h2>
          <div className="week-outbar" role="img" aria-label={`${t('week.outcomes.bar')}: ${outcomeParts.map((o) => `${t(`week.outcome.${o}`)} ${num(data.outcomes[o])} (${pct(data.outcomes[o], closedSum)}%)`).join(', ')}`}>
            {outcomeParts.map((o) => <span key={o} className={`week-seg week-oc-${o}`} style={{ flexGrow: data.outcomes[o] }} title={`${t(`week.outcome.${o}`)} ${num(data.outcomes[o])}`} />)}
          </div>
          <ul className="week-legend">
            {outcomeParts.map((o) => (
              <li key={o}>
                <span className={`week-sw week-oc-${o}`} aria-hidden="true" />
                <span className="week-legend-text">{t(`week.outcome.${o}`)} <b>{num(data.outcomes[o])}</b> <span className="muted">({pct(data.outcomes[o], closedSum)}%)</span></span>
              </li>
            ))}
          </ul>
          <p className="hint week-outcomes-hint">{t('week.outcomes.hint')}</p>
        </section>
      )}

      {data.notable.length > 0 && (
        <section aria-labelledby="week-done-h">
          <h2 id="week-done-h" className="week-h">{t('week.done.title')}</h2>
          <ol className="week-list week-done">
            {data.notable.map((x) => {
              const when = agoText(t, x.closedAt, nowMs);
              return (
                <li key={x.id}>
                  <Link to={caseHref(x)} className="week-row week-done-row">
                    <span className="street-icon"><CategoryIcon k={x.category} size={24} /></span>
                    <span className="week-row-main">
                      <span className="street-type">{x.caseType || t(`street.g.${groupOf(x.category) ?? 'other'}`)}</span>
                      <span className="street-addr">{[x.street || t('street.noStreet'), x.neighborhood].filter(Boolean).join(' · ')}</span>
                      {when && <span className="street-when">{t('street.when.closed', { when })}</span>}
                      <span className="street-note">{x.resolution}</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {data.busiestDay && <p className="week-busiest">{t(data.busiestDay.n === 1 ? 'week.busiest.one' : 'week.busiest', { date: dayName(data.busiestDay.date), n: num(data.busiestDay.n) })}</p>}

      {digestCard}
      <p className="hint week-source">{t('week.source')}</p>
    </article>
  );
}
