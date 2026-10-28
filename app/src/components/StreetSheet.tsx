import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import './StreetSheet.css';

/**
 * Bottom sheet of the /street map page — .claude/street-map-spec.md § sheet, a11y, layout.
 *
 * Three detents above the stage bottom: PEEK (the header only: grabber 44 + title 24 + subtitle 20 + 16 padding
 * = 104 px, +40 when the "Your places" row renders), HALF (50 % of the stage), FULL (stage − 142 px, so the chip
 * rail over the map stays tappable and the OSM attribution under it stays visible). The sheet is an overlay: it never resizes the map. It publishes its live
 * height as `--sheet-h` on the closest `.street-stage` ancestor (falling back to its parent element) on every
 * detent change and every drag frame, so Leaflet's attribution and the parent's `panInside` padding can follow.
 *
 * Gestures (ownership is exact so the map, the sheet and the list never fight):
 *  - pointer drag on the header (grabber + title row + places row) with pointer capture; release snaps to the
 *    nearest detent, or one detent in the drag direction when |velocity| > 0.5 px/ms;
 *  - body at HALF: no scrolling; a touch move of 24 px up raises to FULL, 24 px down drops to PEEK;
 *  - body at FULL: scrolls normally; a 24 px pull down that started at scrollTop 0 drops to HALF;
 *  - grabber: click / Enter / Space cycle peek → half → full → peek, ArrowUp / ArrowDown step one detent.
 *
 * Controlled: `detent` comes from the parent, every user change is reported through `onDetent(d, via)`; the parent
 * is free to set detents itself ('auto' in its analytics). The component imports no i18n — the parent passes the
 * localized labels. On `desktop` it renders a static <aside class="street-panel"> with the same content and no
 * drag code at all.
 */
export type Detent = 'peek' | 'half' | 'full';
/** How the user changed the detent (the parent adds 'auto' for its own programmatic changes). */
export type DetentVia = 'drag' | 'button';
const DETENTS: readonly Detent[] = ['peek', 'half', 'full'];
/** FULL stops this many px under the stage top: 10 + 48 pill + 8 + 44 Show + 8 + 44 When / Type (= 162, Street.tsx
 *  RAIL_BOTTOM) + 6 gap + 17 px OSM attribution (lifted by --sheet-h, it must stay readable and tappable at every
 *  detent) + 9 breathing room. The default of `fullInset` (the parent adds the From / To row while it shows). */
export const SHEET_FULL_INSET = 194;
/** Header height with no places row and a one-line subtitle — the PEEK detent before measurement. */
export const SHEET_PEEK_MIN = 104;

export interface SheetLabels {
  /** Grabber name at PEEK — t('street.sheet.show') */
  show: string;
  /** Grabber name at HALF — t('street.sheet.more') */
  more: string;
  /** Grabber name at FULL — t('street.sheet.hide') */
  hide: string;
  /** The chip shown at FULL that drops back to HALF — t('street.sheet.map'). Empty string → the chip is not rendered. */
  map: string;
}

export interface StreetSheetProps {
  detent: Detent;
  onDetent: (d: Detent, via: DetentVia) => void;
  /** One line, ellipsised — "Providence", the neighborhood, the address. */
  title: string;
  /** The live summary ("42 in view · 18 open · 24 closed"). The parent debounces it (400 ms, only when changed). */
  subtitle: string;
  /** A second subtitle line ("3 new since you last looked (2 days ago)"): plain text, NOT a live region — it changes
   *  with the summary and must not be announced twice. Inside the measured header, so PEEK grows by its 20 px. */
  note?: string;
  labels: SheetLabels;
  /** "Your places" chip row (SavedAddresses). Rendered under the subtitle inside the header; PEEK grows by its height (40 px). */
  places?: ReactNode;
  /** Extra header lines under the subtitle (unplaced / truncated / teach line). Inside the header, so PEEK grows to fit them — keep margins compact. */
  extra?: ReactNode;
  /** Right of the title: the Share icon button (and anything else). The FULL-only "Map" chip is rendered by the sheet itself, left of these. */
  actions?: ReactNode;
  /** Desktop only: the search row + filter rail, rendered at the top of the panel (the phone keeps them floating over the map). */
  controls?: ReactNode;
  /** The body: list / landing / empty states, then the Monday email switch and source line (a case opens over the page:
   *  components/StreetCasePage). */
  children: ReactNode;
  /** The tail nav (About · Privacy · language · disclaimer). Pass null on desktop, where the page footer stays. */
  tail?: ReactNode;
  /** ≥720 px: render <aside class="street-panel"> instead of the sheet. */
  desktop: boolean;
  /** aria-label of the desktop <aside> — t('nav.street'). Defaults to `title`. */
  panelLabel?: string;
  /** aria-busy on the body while a window refetches (the previous set stays on screen). */
  busy?: boolean;
  /** The measured PEEK height (the header), whenever it changes — not the live --sheet-h, which lags a detent change. */
  onPeekHeight?: (h: number) => void;
  /** How far under the stage top FULL stops (default SHEET_FULL_INSET); a change re-measures. */
  fullInset?: number;
}

interface Heights { peek: number; half: number; full: number }

/** Detent heights for a stage of `stageH` px and a measured header of `peekH` px; monotonic even on tiny stages. */
function sheetHeights(stageH: number, peekH: number, inset: number): Heights {
  const peek = Math.max(0, Math.round(peekH));
  const full = Math.max(peek, Math.round(stageH - inset));
  const half = Math.min(full, Math.max(peek, Math.round(stageH / 2)));
  return { peek, half, full };
}

/** Where a drag released at height `h` with velocity `v` (px/ms, up = positive) lands. */
function snapDetent(h: number, v: number, hs: Heights): Detent {
  if (v > 0.5) return DETENTS.find((d) => hs[d] > h) ?? 'full';
  if (v < -0.5) return [...DETENTS].reverse().find((d) => hs[d] < h) ?? 'peek';
  let best: Detent = 'peek';
  for (const d of DETENTS) if (Math.abs(hs[d] - h) < Math.abs(hs[best] - h)) best = d;
  return best;
}

const DRAG_START_PX = 6;
const SWIPE_PX = 24;
const VELOCITY_WINDOW_MS = 100;

interface Drag { active: boolean; id: number; startY: number; startH: number; dragged: boolean; samples: { t: number; h: number }[] }
const idleDrag = (): Drag => ({ active: false, id: -1, startY: 0, startH: 0, dragged: false, samples: [] });

export default function StreetSheet(props: StreetSheetProps) {
  const { detent, onDetent, title, subtitle, note, labels, places, extra, actions, controls, children, tail, desktop, panelLabel, busy } = props;

  const sheetRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLElement | null>(null);
  const insetRef = useRef(props.fullInset ?? SHEET_FULL_INSET);
  insetRef.current = props.fullInset ?? SHEET_FULL_INSET;
  const heightsRef = useRef<Heights>(sheetHeights(0, SHEET_PEEK_MIN, insetRef.current));
  const measureRef = useRef<(() => void) | null>(null);
  const onPeekRef = useRef(props.onPeekHeight);
  onPeekRef.current = props.onPeekHeight;
  const dragRef = useRef<Drag>(idleDrag());
  const detentRef = useRef(detent);
  const onDetentRef = useRef(onDetent);
  useLayoutEffect(() => { detentRef.current = detent; onDetentRef.current = onDetent; });

  const publish = (h: number) => { stageRef.current?.style.setProperty('--sheet-h', `${Math.round(h)}px`); };

  // Measure the stage and the header; keep the detent heights and --sheet-h current on resize / rotation / places row.
  useLayoutEffect(() => {
    if (desktop) return;
    const sheet = sheetRef.current; const top = topRef.current;
    if (!sheet || !top) return;
    const stage = (sheet.closest('.street-stage') as HTMLElement | null) ?? sheet.parentElement;
    stageRef.current = stage;
    const measure = () => {
      const stageH = stage?.clientHeight || window.innerHeight;
      const peekH = top.offsetHeight + sheet.clientTop; // + the top border, so the header is never clipped at PEEK
      heightsRef.current = sheetHeights(stageH, peekH, insetRef.current);
      if (!dragRef.current.active) publish(heightsRef.current[detentRef.current]);
      onPeekRef.current?.(heightsRef.current.peek);
    };
    // First paint lands directly on the detent: no 220 ms slide up from the CSS fallback height.
    sheet.classList.add('is-mounting');
    measure();
    measureRef.current = measure;
    void sheet.offsetHeight; // flush the height while the transition is off
    sheet.classList.remove('is-mounting');
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure);
      if (stage) ro.observe(stage);
      ro.observe(top);
    } else window.addEventListener('resize', measure);
    return () => { ro?.disconnect(); window.removeEventListener('resize', measure); stage?.style.removeProperty('--sheet-h'); stageRef.current = null; measureRef.current = null; };
  }, [desktop]);
  // A new FULL inset (the parent's rail grew or shrank): new detent heights, and FULL moves with it.
  useLayoutEffect(() => { measureRef.current?.(); }, [props.fullInset]);

  // Every detent change (ours or the parent's) lands on --sheet-h; the CSS height transition does the motion.
  useLayoutEffect(() => { if (!desktop && !dragRef.current.active) publish(heightsRef.current[detent]); }, [detent, desktop]);

  // Body swipes (touch only — pointer events would be cancelled by the browser's own scroll handling at FULL).
  useEffect(() => {
    if (desktop) return;
    const body = bodyRef.current;
    if (!body) return;
    let startY = 0; let atTop = false; let fired = false; let tracking = false;
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) { tracking = false; return; }
      tracking = true; fired = false; startY = e.touches[0].clientY; atTop = body.scrollTop <= 0;
    };
    const onMove = (e: TouchEvent) => {
      if (!tracking || fired || e.touches.length !== 1) return;
      const dy = e.touches[0].clientY - startY; // finger down = positive
      const d = detentRef.current;
      if (d === 'half') {
        if (dy <= -SWIPE_PX) { fired = true; onDetentRef.current('full', 'drag'); }
        else if (dy >= SWIPE_PX) { fired = true; onDetentRef.current('peek', 'drag'); }
      } else if (d !== 'peek' && atTop && dy >= SWIPE_PX && body.scrollTop <= 0) { fired = true; onDetentRef.current(d === 'full' ? 'half' : 'peek', 'drag'); }
    };
    const onEnd = () => { tracking = false; };
    body.addEventListener('touchstart', onStart, { passive: true });
    body.addEventListener('touchmove', onMove, { passive: true });
    body.addEventListener('touchend', onEnd, { passive: true });
    body.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      body.removeEventListener('touchstart', onStart); body.removeEventListener('touchmove', onMove);
      body.removeEventListener('touchend', onEnd); body.removeEventListener('touchcancel', onEnd);
    };
  }, [desktop]);

  const go = (d: Detent, via: DetentVia) => { if (d !== detent) onDetent(d, via); };
  const up = (d: Detent): Detent => (d === 'peek' ? 'half' : 'full');
  const down = (d: Detent): Detent => (d === 'full' ? 'half' : 'peek');

  // --- header drag (pointer events on the grabber + title row + places row) ---
  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || dragRef.current.active) return;
    const h = heightsRef.current[detent];
    dragRef.current = { active: true, id: e.pointerId, startY: e.clientY, startH: h, dragged: false, samples: [{ t: e.timeStamp, h }] };
  }
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d.active || e.pointerId !== d.id) return;
    const dy = d.startY - e.clientY; // finger up = taller
    if (!d.dragged) {
      if (Math.abs(dy) < DRAG_START_PX) return; // a tap stays a tap (the click reaches the grabber / Share / a places chip)
      d.dragged = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      sheetRef.current?.classList.add('is-dragging');
    }
    const { peek, full } = heightsRef.current;
    const h = Math.min(full, Math.max(peek, d.startH + dy));
    d.samples.push({ t: e.timeStamp, h });
    while (d.samples.length > 1 && e.timeStamp - d.samples[0].t > VELOCITY_WINDOW_MS) d.samples.shift();
    publish(h);
  }
  function endDrag(e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) {
    const d = dragRef.current;
    if (!d.active || e.pointerId !== d.id) return;
    d.active = false;
    sheetRef.current?.classList.remove('is-dragging');
    if (!d.dragged) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const hs = heightsRef.current;
    // Velocity over the last 100 ms before the lift — a finger that paused and then let go is not a fling.
    while (d.samples.length > 1 && e.timeStamp - d.samples[0].t > VELOCITY_WINDOW_MS) d.samples.shift();
    const first = d.samples[0]; const last = d.samples[d.samples.length - 1];
    const dt = last.t - first.t;
    const v = cancelled || dt <= 0 ? 0 : (last.h - first.h) / dt;
    const target = cancelled ? detent : snapDetent(last.h, v, hs);
    publish(hs[target]);
    // The click that follows pointerup is swallowed by onClickCapture; clear the flag right after it.
    if (cancelled) d.dragged = false; else window.setTimeout(() => { d.dragged = false; }, 0);
    go(target, 'drag');
  }
  function onClickCapture(e: MouseEvent<HTMLDivElement>) {
    if (dragRef.current.dragged) { e.preventDefault(); e.stopPropagation(); dragRef.current.dragged = false; }
  }

  // --- grabber keyboard ---
  function onGrabKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'ArrowUp') { e.preventDefault(); if (detent !== 'full') go(up(detent), 'button'); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); if (detent !== 'peek') go(down(detent), 'button'); }
  }
  const cycle = () => go(detent === 'full' ? 'peek' : up(detent), 'button');
  const grabLabel = detent === 'peek' ? labels.show : detent === 'half' ? labels.more : labels.hide;

  // The one live region (the summary, "Link copied") keeps its element in every mode.
  const headRow = (
    <div className="street-head-row">
      <div className="street-head-text">
        <h2 className="street-title">{title}</h2>
        <p className="street-sub" role="status" aria-live="polite">{subtitle}</p>
        {note && <p className="street-since">{note}</p>}
      </div>
      {(actions || (!desktop && detent === 'full' && labels.map)) && (
        <div className="street-head-actions">
          {!desktop && detent === 'full' && labels.map && (
            <button type="button" className="chip street-map-chip" onClick={() => go('half', 'button')}>{labels.map}</button>
          )}
          {actions}
        </div>
      )}
    </div>
  );

  if (desktop) {
    return (
      <aside className="street-panel" aria-label={panelLabel ?? title}>
        {controls && <div className="street-panel-controls">{controls}</div>}
        {headRow}
        {extra && <div className="street-extra">{extra}</div>}
        {places && <div className="street-places">{places}</div>}
        <div id="street-sheet-body" className="street-body" aria-busy={busy || undefined}>
          {children}
          {tail}
        </div>
      </aside>
    );
  }

  return (
    <div ref={sheetRef} className="street-sheet" data-detent={detent}>
      <div ref={topRef} className="street-sheet-top" onPointerDown={onPointerDown} onPointerMove={onPointerMove}
        onPointerUp={(e) => endDrag(e, false)} onPointerCancel={(e) => endDrag(e, true)} onClickCapture={onClickCapture}>
        <div className="street-head">
          <button type="button" className="street-grab" aria-expanded={detent !== 'peek'} aria-controls="street-sheet-body" aria-label={grabLabel}
            data-detent={detent} onClick={cycle} onKeyDown={onGrabKey}>
            <span className="street-grab-pill" aria-hidden="true" />
          </button>
          {headRow}
          {extra && <div className="street-extra">{extra}</div>}
        </div>
        {places && <div className="street-places">{places}</div>}
      </div>
      {/* inert at PEEK: the body is clipped to 0 px there, so Tab must not land on invisible rows — the grabber ("Show list") opens it. */}
      <div ref={bodyRef} id="street-sheet-body" className="street-body" aria-busy={busy || undefined} inert={detent === 'peek'}>
        {children}
        {tail}
      </div>
    </div>
  );
}
