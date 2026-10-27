import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getWeek, resetWeekCache, WEEK_OUTCOMES, type WeekHood, type WeekNotable, type WeekSummary } from '../api/week';
import { getMe, placedAddresses, updateMe, type Me } from '../api/me';
import { ApiError } from '../api/types';
import { useSession } from '../lib/auth';
import { track } from '../lib/analytics';
import { useI18n } from '../i18n';
import { groupOf } from '../lib/categories';
import { addDays, todayNY, weekLinkProblem, WEEK_TZ as TZ, YMD } from '../lib/week';
import { hoodOfSync, hoodSlug, loadNeighborhoods } from '../lib/neighborhoods';
import { weekPostMarkdown } from '../lib/weekPost';
import { BRAND } from '../brand';
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
 *  it in `untilDate`); a past week is titled by its range and gets ‹ Previous · Next › · Latest week links.
 *
 *  Your neighborhood (2026-10-27): every hood row says "N closed · median X days" (the Worker's per-hood median); signed
 *  in, the hoods of the reader's saved places (api/me placedAddresses — /street's "Your places this week" list) are
 *  tagged "Yours" and pinned on top even outside the top 8 or with nothing this week, and the first of them with a median
 *  gets one line against the city's. "Show all N neighborhoods" opens the rest; "Show fewer" scrolls the button back into
 *  view. Each count is "N requests" to a screen reader. */

const HOODS_SHOWN = 8;
const FLASH_MS = 2500;

/** Text onto the clipboard, with the old way as a fallback: `navigator.clipboard` is undefined on an insecure origin
 *  (plain http off localhost — how the dev box is reviewed from a phone) and `writeText` rejects without permission, so
 *  a throwaway textarea + execCommand('copy') runs next, inside the same tap. True when the text is on the clipboard. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator.clipboard?.writeText === 'function') { await navigator.clipboard.writeText(text); return true; }
  } catch { /* blocked: try the old way */ }
  const prev = document.activeElement as HTMLElement | null;
  const ta = document.createElement('textarea');
  try {
    ta.value = text; ta.readOnly = true; ta.setAttribute('aria-hidden', 'true'); ta.tabIndex = -1;
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;';
    document.body.appendChild(ta);
    ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
    return document.execCommand('copy') === true;
  } catch { return false; } finally {
    ta.remove();
    prev?.focus?.();
  }
}

export default function Week() {
  const { t, lang } = useI18n();
  const session = useSession();
  const locale = lang === 'es' ? 'es' : 'en-US';
  const num = (n: number) => n.toLocaleString(locale);
  const [params] = useSearchParams();
  /** The week asked for: null = the current week. Validity is the Worker's call (400 → the error state). */
  const until = params.get('until') || null;
  /** A dated link the Worker is certain to 400 (lib/week.ts: malformed, future, or past the archive floor) loads as the
   *  short error view it will become — no skeleton, no reserved head rows — so nothing tall collapses when the 400 lands. */
  const badLinkAhead = weekLinkProblem(until) != null;

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

  /* ── Share / Copy as post ─────────────────────────────────────────────────────────────────────── */
  const [flash, setFlash] = useState('');
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);
  /** One live region for both buttons; the message clears itself. */
  const showFlash = (msg: string) => {
    setFlash(msg);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(''), FLASH_MS);
  };
  async function share() {
    const href = `${window.location.origin}${datedPath}`;
    track('week_share', { current: !dated });
    if (typeof navigator.share === 'function') {
      try { await navigator.share({ title, url: href }); } catch { /* cancelled */ }
      return;
    }
    showFlash(t(await copyText(href) ? 'week.copied' : 'week.copyFailed'));
  }
  /** The week as a Markdown post (lib/weekPost.ts) on the clipboard — for the Monday r/providence post. The link in
   *  it is the canonical site, not this origin, so a post written from a preview host still points residents home.
   *  When nothing can write the clipboard (insecure origin without execCommand, permission refused), the post is shown
   *  in a read-only textarea with Select all, so it can still be copied by hand. */
  const [manual, setManual] = useState<string | null>(null);
  const manualRef = useRef<HTMLTextAreaElement>(null);
  const selectManual = () => { const el = manualRef.current; if (!el) return; el.focus(); el.select(); el.setSelectionRange(0, el.value.length); };
  useEffect(() => { if (manual != null) selectManual(); }, [manual]);
  async function copyPost() {
    if (!data) return;
    track('week_post', { current: !dated });
    const md = weekPostMarkdown(data, { base: BRAND.siteUrl });
    if (await copyText(md)) { setManual(null); showFlash(t('week.post.copied')); return; }
    setManual(md);
    showFlash(t('week.post.failed'));
  }
  /** Share over Copy as post in the head's right-hand column. `skel` = the invisible twin that holds the column while
   *  the numbers load, so the title wraps the same way before and after. */
  const actions = (skel: boolean) => (
    <div className={`week-actions${skel ? ' week-actions--skel' : ''}`} aria-hidden={skel || undefined}>
      <button type="button" className="btn btn-ghost week-share" onClick={share} tabIndex={skel ? -1 : undefined} disabled={skel}>{t('week.share')}</button>
      <button type="button" className="btn btn-ghost week-post" onClick={copyPost} tabIndex={skel ? -1 : undefined} disabled={skel}>{t('week.post')}</button>
    </div>
  );

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

  /* ── "Yours": the neighborhoods of the saved places ─────────────────────────────────────────────── */
  /** Hood names of the reader's saved places with coordinates, in the account's order, once each; [] signed out, without
   *  places, or until the rings have loaded — lib/neighborhoods' lazy chunk, fetched only when there are places. */
  const places = useMemo(() => (session && me ? placedAddresses(me.addresses) : []), [session, me]);
  const [resolvedHoods, setResolvedHoods] = useState<string[]>([]);
  const yourHoods = places.length ? resolvedHoods : [];
  useEffect(() => {
    if (!places.length) return;
    let live = true;
    loadNeighborhoods().then((nb) => {
      if (!live) return;
      const names: string[] = [];
      for (const a of places) { const h = hoodOfSync(nb, a.lat, a.lng); if (h && !names.includes(h)) names.push(h); }
      setResolvedHoods((cur) => (cur.join('|') === names.join('|') ? cur : names));   // a prefs PATCH re-runs this; keep the same list
    }).catch(() => { /* the rings did not load: the plain list */ });
    return () => { live = false; };
  }, [places]);
  const [allHoods, setAllHoods] = useState(false);
  const hoodsMore = useRef<HTMLButtonElement>(null);

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
  /** While the numbers load, the head keeps the range line's and the week nav's height (a bar and an empty row) so the
   *  stat tiles land exactly where the skeleton's tiles stood — the loaded page never pushes anything down. */
  const loading = state === 'loading' && !data && !badLinkAhead;
  const head = (
    <header className="week-head">
      <h1 id="week-title">{title}</h1>
      {data && !dated && <p className="week-range">{t('week.range', { from: day(data.since), to: day(data.until) })}</p>}
      {data && dated && weekFrom && untilDate && <p className="week-range">{t('week.rangeOf', { from: fromYmd(weekFrom, { weekday: 'long' }), to: fromYmd(untilDate, { weekday: 'long' }) })}</p>}
      {loading && <p className="week-range week-range--skel" aria-hidden="true"><span /></p>}
      {data && data.total > 0 && actions(false)}
      {loading && actions(true)}
      {data && weekNav({ prev: data.prevUntil, next: data.nextUntil, latest: !data.current })}
      {loading && <div className="week-nav week-nav--skel" aria-hidden="true" />}
      <p className="week-flash" role="status">{flash}</p>
      {manual != null && (
        <div className="week-manual">
          <textarea ref={manualRef} className="textarea week-manual-text" readOnly value={manual} rows={8} aria-label={t('week.post.manual')} onFocus={(e) => e.currentTarget.select()} />
          <div className="week-manual-actions">
            <button type="button" className="btn btn-ghost" onClick={selectManual}>{t('week.post.selectAll')}</button>
            <button type="button" className="btn btn-ghost" onClick={() => setManual(null)}>{t('week.post.hide')}</button>
          </div>
        </div>
      )}
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
        {/* The skeleton has the loaded page's geometry down past the first screen (three stat tiles, a heading, the six
            type rows, a heading, eight neighborhood rows — Week.css pins the heights), so nothing in view moves when the
            numbers land and the footer stays below the fold throughout (CLS was 0.39 with a short skeleton). A link
            that will 400 gets no skeleton: the error view is a few lines, and that is what it should load as. */}
        {!badLinkAhead && <div className="week-skel" aria-hidden="true">
          <div className="week-skel-stats"><i /><i /><i /></div>
          <div className="week-skel-h" />
          <div className="week-skel-list">{Array.from({ length: 6 }, (_, i) => <i key={i} />)}</div>
          <div className="week-skel-h" />
          <div className="week-skel-list week-skel-list--hoods">{Array.from({ length: HOODS_SHOWN }, (_, i) => <i key={i} />)}</div>
        </div>}
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
  // Yours first, in the list's own order (n desc), then any with nothing this week in the places' order; under them the top
  // 8 of the rest, or all of it once "Show all" is pressed. Signed out (yourHoods = []) this is the plain top 8.
  const yours = new Set(yourHoods);
  const active = new Set(data.neighborhoods.map((h) => h.name));
  const pinned: WeekHood[] = [
    ...data.neighborhoods.filter((h) => yours.has(h.name)),
    ...yourHoods.filter((name) => !active.has(name)).map((name) => ({ name, slug: hoodSlug(name), n: 0, open: 0, closed: 0, medianCloseDays: null })),
  ];
  const others = data.neighborhoods.filter((h) => !yours.has(h.name));
  const topOthers = data.neighborhoods.slice(0, HOODS_SHOWN).filter((h) => !yours.has(h.name));
  const hoods = [...pinned, ...(allHoods ? others : topOthers)];
  const hoodsHidden = others.length > topOthers.length;
  const hoodMax = data.neighborhoods.reduce((m, h) => Math.max(m, h.n), 0);
  const daysText = (d: number) => t(d === 1 ? 'week.hoods.days.one' : 'week.hoods.days', { n: num(d) });
  /** The first yours-hood with a median, against the city's. */
  const compare = data.medianCloseDays != null ? pinned.find((h) => h.medianCloseDays != null) : undefined;

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
          <ol className="week-list week-hoods" id="week-hoods-list">
            {hoods.map((h) => {
              const mine = yours.has(h.name);
              const quiet = h.n === 0;
              // "6 closed · median 2.5 days" (the median left out when the hood had no dated close); a quiet yours-hood says so instead.
              const sub = quiet ? t('week.hoods.none') : [
                t(h.closed === 1 ? 'week.hoods.closed.one' : 'week.hoods.closed', { n: num(h.closed) }),
                h.medianCloseDays != null ? t('week.hoods.median', { days: daysText(h.medianCloseDays) }) : '',
              ].filter(Boolean).join(' · ');
              return (
                <li key={h.slug}>
                  <Link to={`/street?n=${encodeURIComponent(h.slug)}`} className={`week-row week-hood${mine ? ' week-hood--yours' : ''}`}>
                    <span className="week-hood-name">{h.name}{mine && <>{' '}<span className="week-hood-yours">{t('week.hoods.yours')}</span></>}</span>
                    {/* The count named for a screen reader ("48 requests"), so it never reads as a bare number next to "18 closed". */}
                    {!quiet && <b className="week-row-n"><span aria-hidden="true">{num(h.n)}</span><span className="week-vh">{t(h.n === 1 ? 'week.hoods.requests.one' : 'week.hoods.requests', { n: num(h.n) })}</span></b>}
                    <span className="week-row-sub week-hood-sub">{sub}</span>
                    {!quiet && <span className="week-hood-bar" aria-hidden="true"><span style={{ width: `${hoodMax ? Math.max(2, Math.round((100 * h.n) / hoodMax)) : 0}%` }} /></span>}
                  </Link>
                </li>
              );
            })}
          </ol>
          {/* The same button element either way, so focus stays on it when the list grows or shrinks above it. Show fewer
              drops up to 17 rows (~1,500 px) above it, and nothing holds the scroll: iOS Safari has no scroll anchoring and
              Chrome's anchor is one of the removed rows — so once the short list has rendered, the button comes back on screen. */}
          {hoodsHidden && (
            <button ref={hoodsMore} type="button" className="btn btn-ghost week-hoods-more" aria-expanded={allHoods} aria-controls="week-hoods-list" onClick={() => {
              if (allHoods) requestAnimationFrame(() => hoodsMore.current?.scrollIntoView({ block: 'nearest' }));
              setAllHoods((v) => !v);
            }}>
              {allHoods ? t('week.hoods.fewer') : t('week.hoods.all', { n: num(pinned.length + others.length) })}
            </button>
          )}
          {compare && <p className="week-hood-compare">{t('week.hoods.compare', { hood: compare.name, days: daysText(compare.medianCloseDays!), city: num(data.medianCloseDays!) })}</p>}
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
