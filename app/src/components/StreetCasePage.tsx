import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useI18n } from '../i18n';
import { caseAge, caseDay, caseTimeline, fullAddressLine, NEARBY_M, reportHref, type CaseDetail, type MapCase } from '../lib/streetMap';
import CategoryIcon from './CategoryIcon';
import MapView, { type MapPoint } from './MapView';
import StreetRow, { StatusPill, statusText } from './StreetRow';
import './StreetParts.css';
import './StreetCasePage.css';

/** The case page (Rob, 2026-10-27, with a Zillow listing opened over its map: "when you click on a pin you should get
 *  like a full screen overlay not just filter to it in the side panel, also clicking in the sidepanel should give you
 *  detailed view"). A modal dialog over /street, portalled to <body> with the app root `inert` behind it (so the map,
 *  the sheet/panel and the tab bar are out of reach, for the pointer, Tab and screen readers alike): at ≥ 720 px a
 *  centred card min(1100 px, 100vw − 48 px) wide over a dimmed backdrop, scrolling inside; on phones the whole screen,
 *  tab bar included — a modal must leave nothing usable behind it, and the tab bar would have been a dead strip under
 *  it; "‹ Back to map" and the system Back are the way out, and the 84 px it would have kept go to the page.
 *  Order: the sticky top bar ("‹ Back to map" · Follow · Share), the hero (a static mini-map of the spot + the title
 *  block: type, address, neighborhood, status pill), the stat row (how long open / to close · reported · distance from
 *  the point or the neighborhood), the fact tiles (type, status, sent to the department, work completed), then the
 *  sections: timeline, what was reported, the city's note, nearby (rows that swap the page to that case). The dialog
 *  takes focus when it opens and when the case changes, keeps Tab inside, and Escape / the backdrop / "Back to map"
 *  call `onClose`; the caller owns the URL, history and the focus return. The keys are heard on the document, not the
 *  dialog: a control that swaps itself out drops focus to <body>, where the dialog's own keydown never fires. Answers
 *  are text nodes, never HTML. */

export interface CaseMore { state: 'loading' | 'ok' | 'error'; detail: CaseDetail | null }
export interface NearbyRow { c: MapCase; m: number; hood: string | null }

export interface StreetCasePageProps {
  c: MapCase;
  hood: string | null;
  /** The home point's short name and its distance from the case, when a point is set (the stat row's third item;
   *  without one, the neighborhood). */
  /** Distance from the point the map is about; `place` null = the visitor's own location (no address to name). */
  from: { m: number; place: string | null } | null;
  /** GET /api/street/case/:id's `detail`: 'loading' → a small skeleton; 'error' or no detail → the basic page only. */
  more: CaseMore;
  nowMs: number;
  /** Other cases within NEARBY_M of this one from the loaded feed (lib/streetMap nearbyCases), nearest first. */
  nearby: NearbyRow[];
  /** The loaded window in days: what "Nearby" looked through. */
  days: number;
  /** A nearby row: the caller swaps the page to that case. */
  onNearby: (id: string) => void;
  /** "‹ Back to map", Escape and a tap on the backdrop. */
  onClose: () => void;
  onShare: () => void;
  /** "Link copied" after Share — the page's own status line (the sheet's live region is inert behind it). */
  flash: string | null;
  /** The Follow toggle (components/StreetFollow) for the top bar, handed the element its lines render into. */
  follow: (notes: HTMLElement | null) => ReactNode;
}

const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const BackIcon = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>;
const ShareIcon = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v12" /><path d="M8 7l4-4 4 4" /><path d="M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7" /></svg>;

export default function StreetCasePage({ c, hood, from, more, nowMs, nearby, days, onNearby, onClose, onShare, flash, follow }: StreetCasePageProps) {
  const { t, lang } = useI18n();
  const titleId = useId();
  const tlId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [notes, setNotes] = useState<HTMLDivElement | null>(null);
  const locale = lang === 'es' ? 'es' : 'en-US';

  // Everything behind the dialog is inert while it is open, and the page under it does not scroll.
  useEffect(() => {
    const root = document.getElementById('root');
    root?.setAttribute('inert', '');
    document.body.classList.add('has-case');
    return () => { root?.removeAttribute('inert'); document.body.classList.remove('has-case'); };
  }, []);
  // Focus the dialog (named by the case type) when it opens and when a nearby row swaps the case; a new case starts at the top.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = 0;
    el.focus({ preventScroll: true });
  }, [c.id]);
  // Escape and the Tab trap, wherever focus is while the dialog is up (everything else is inert, so that is the dialog
  // or <body>). From <body>, Tab starts at the first control and Shift+Tab at the last, as from the dialog itself.
  const closeRef = useRef(onClose);
  useLayoutEffect(() => { closeRef.current = onClose; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); return; }
      if (e.key !== 'Tab') return;
      const dlg = ref.current;
      if (!dlg) return;
      const list = Array.from(dlg.querySelectorAll<HTMLElement>(TABBABLE)).filter((el) => el.getClientRects().length > 0);
      if (list.length === 0) { e.preventDefault(); return; }
      const first = list[0], last = list[list.length - 1], a = document.activeElement;
      const lost = !(a instanceof Node && dlg.contains(a));
      if (e.shiftKey && (a === first || a === dlg || lost)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (a === last || lost)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  /** "Oct 24" (the year too when it is not this one), in Providence's time. '' when it will not parse. */
  const day = (iso: string | null) => caseDay(iso, nowMs, locale);

  const located = c.lat != null && c.lng != null;
  const points = useMemo<MapPoint[]>(() => (c.lat != null && c.lng != null ? [{ id: c.id, lat: c.lat, lng: c.lng, open: c.open, group: c.group }] : []), [c]);
  const typeName = c.caseType || t(`group.${c.group}`);
  // Pins placed by street name alone (no house number) stand for the whole street.
  const approx = located && c.street !== '' && !/^\d/.test(c.street);
  const detail = more.state === 'ok' ? more.detail : null;
  const place = (detail ? fullAddressLine(c.street, detail.address) : null) ?? c.street;
  const address = place || t('street.noStreet');
  const steps = detail ? caseTimeline(c, detail) : [];
  const after = (n: number) => (n === 0 ? t('street.case.after.same') : t(n === 1 ? 'street.case.after.one' : 'street.case.after', { n }));
  const daysText = (n: number) => t(n === 1 ? 'street.case.stat.days.one' : 'street.case.stat.days', { n });

  // The stat row (Zillow's beds · baths · sqft): how long it has been open or took to close, when it was reported, and
  // how far it is from the point you searched — or, without one, its neighborhood. Label over value; each reads as one phrase.
  const stats: { key: string; k: string; v: string }[] = [];
  const age = caseAge(c, nowMs);
  if (age?.open) stats.push({ key: 'age', k: t('street.case.stat.open'), v: age.days === 0 ? t('street.case.stat.today') : daysText(age.days) });
  else if (age) stats.push(age.days === 0 ? { key: 'age', k: t('street.case.stat.closed'), v: t('street.case.stat.sameDay') } : { key: 'age', k: t('street.case.stat.closedAfter'), v: daysText(age.days) });
  const reported = day(c.createdAt);
  if (reported) stats.push({ key: 'reported', k: t('street.case.stat.reported'), v: reported });
  if (from) stats.push({ key: 'from', k: from.place ? t('street.case.stat.from', { place: from.place }) : t('street.case.stat.fromYou'), v: t('street.meters', { m: from.m }) });
  else if (hood) stats.push({ key: 'hood', k: t('street.case.stat.hood'), v: hood });

  // Fact tiles: the type group and the status always; the department hand-off and the work order's completion once the
  // city's form has them.
  const tiles: { key: string; k: string; v: string }[] = [{ key: 'group', k: t('street.case.tile.group'), v: t(`group.${c.group}`) }];
  if (c.status) tiles.push({ key: 'status', k: t('street.case.tile.status'), v: statusText(t, c.status) });
  const routed = day(detail?.timeline.routed ?? null);
  if (routed) tiles.push({ key: 'routed', k: t('street.case.step.routed'), v: routed });
  const worked = day(detail?.timeline.workCompleted ?? null);
  if (worked) tiles.push({ key: 'workCompleted', k: t('street.case.step.workCompleted'), v: worked });

  return createPortal(
    <div className="case-layer">
      <div className="case-backdrop" aria-hidden="true" onClick={onClose} />
      <div ref={ref} className="case-page" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-id={c.id}>
        <div className="case-bar">
          <button type="button" className="case-back" onClick={onClose}>{BackIcon}{t('street.case.back')}</button>
          <div className="case-bar-actions">
            {follow(notes)}
            <button type="button" className="case-share" onClick={onShare}>{ShareIcon}<span className="case-share-label">{t('street.detail.share')}</span></button>
          </div>
          <p className="case-flash" role="status">{flash}</p>
        </div>

        <div className={`case-hero${located ? '' : ' case-hero--nomap'}`}>
          {located && (
            <div className="case-map">
              <MapView ariaLabel={t('street.case.map', { place: c.street || typeName })} frameless zoomControl={false} interactive={false}
                center={[c.lat!, c.lng!]} zoom={17} points={points} selectedId={c.id} panToSelection={false} />
            </div>
          )}
          <div className="case-head">
            <div className="case-type">
              <span className="street-icon street-icon--lg"><CategoryIcon k={c.category} size={32} /></span>
              <h2 id={titleId} className="case-title">{typeName}</h2>
            </div>
            <p className="case-addr">{address}</p>
            {hood && <p className="case-hood">{hood}</p>}
            {c.status && <p className="case-pill"><StatusPill status={c.status} /></p>}
            {approx && <p className="hint case-approx">{t('street.detail.approx')}</p>}
            <div ref={setNotes} className="case-follow-notes" />
          </div>
        </div>

        {stats.length > 0 && (
          <dl className="case-stats">
            {stats.map((s) => <div key={s.key} className="case-stat" data-stat={s.key}><dt>{s.k}</dt><dd>{s.v}</dd></div>)}
          </dl>
        )}
        <dl className="case-tiles">
          {tiles.map((s) => <div key={s.key} className="case-tile" data-tile={s.key}><dt>{s.k}</dt><dd>{s.v}</dd></div>)}
        </dl>

        <div className="case-body">
          <div className="case-main" aria-busy={more.state === 'loading' || undefined}>
            {more.state === 'loading' && <div className="case-skel" aria-hidden="true"><span /><span /><span /></div>}
            {steps.length > 1 && (
              <section className="case-section" data-section="timeline">
                <h3 id={tlId} className="street-h">{t('street.case.timeline')}</h3>
                <ol className="street-tl" aria-labelledby={tlId}>
                  {steps.map((s) => (
                    <li key={s.step} className="street-tl-step" data-step={s.step}>
                      <span className="street-tl-label">{t(`street.case.step.${s.step}`)}</span>
                      <time className="street-tl-date" dateTime={s.at}>{day(s.at)}</time>
                      {s.days != null && <span className="street-tl-days">{after(s.days)}</span>}
                    </li>
                  ))}
                </ol>
              </section>
            )}
            {detail && detail.answers.length > 0 && (
              <section className="case-section" data-section="answers">
                <h3 className="street-h">{t('street.case.answers')}</h3>
                <dl className="street-answers">
                  {detail.answers.map((a, i) => <div key={i}><dt>{a.label}</dt><dd>{a.value}</dd></div>)}
                </dl>
              </section>
            )}
            {!c.open && c.resolution && (
              <section className="case-section" data-section="note">
                <h3 className="street-h">{t('street.case.note')}</h3>
                <blockquote className="street-note">{c.resolution}</blockquote>
              </section>
            )}
          </div>
          <div className="case-side">
            {located && (
              <section className="case-section case-nearby" data-section="nearby">
                <h3 className="street-h">{t('street.case.nearby')}</h3>
                {nearby.length > 0 ? (
                  <>
                    <p className="hint case-nearby-hint">{t('street.case.nearby.hint', { m: NEARBY_M, days })}</p>
                    <ul className="street-list">
                      {nearby.map((n) => <StreetRow key={n.c.id} c={n.c} hood={n.hood} distanceM={n.m} onSelect={onNearby} nowMs={nowMs} />)}
                    </ul>
                  </>
                ) : <p className="hint case-nearby-hint">{t('street.case.nearby.none', { m: NEARBY_M, days })}</p>}
              </section>
            )}
            <p className="case-report"><Link to={reportHref(located ? { lat: c.lat!, lng: c.lng! } : null, place)} className="btn btn-secondary">{t('street.report')}</Link></p>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
