import { useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent } from 'react';
import { GROUP_ORDER } from '@shared/categories';
import { clampRange, DEFAULT_FILTERS, defaultRange, isYmd, rangeBounds, type FacetCounts, type Filters, type Window } from '../lib/streetMap';
import type { GroupKey } from '../lib/categories';
import { useT } from '../i18n';
import './StreetParts.css';

/** The /street filters (spec: .claude/street-map-spec.md "filters"; Rob, 2026-10-27: "filters are confusing" — the old
 *  chip rail mixed two independent status toggles, a pick-one type rail and a chip-like select, all with the same
 *  "pressed" look; then "24 hours should be one of the timeframes", a custom timeframe, and several types at once).
 *  Three controls:
 *  - Show: All / Open / Closed — a segmented control built from a fieldset + legend and native radios (arrow keys move
 *    within it). Open and Closed carry a dot in the pin colours (ember / muted) so it doubles as the pins' legend
 *    (decorative: the names already say open / closed).
 *  - When: the window select (24 hours / 7 days / 30 / 90 days / Custom range…). Custom range… reveals From and
 *    To date inputs (Providence calendar days, today − 89 … today; From ≤ To by their bounds — From's max is To, To's
 *    min is From — so a date never moves the other one: desktop browsers apply a typed date at every complete keystroke,
 *    and "25" typed into To's day reads the 2nd on the way). A typed date that is not a whole day inside its box's
 *    bounds stays on screen unapplied until it is, and goes back to the applied one on blur.
 *  - Type: a button that reads the selection ("All types · n", "Trash · n", "Trash +2 · n") and opens a small
 *    non-modal dialog of checkboxes — "All types", then every group in GROUP_ORDER with its count, zero counts listed
 *    too (picking one leads to the counted empty state). Any combination; none = all; "All types" clears. Escape, Done,
 *    the button again or a tap outside closes it, focus back on the button (after an outside tap only when focus was
 *    still inside); tabbing out of it closes it too, focus staying where it went (MapKey's rules). It is fixed to the
 *    screen under its button, kept inside the screen's 12 px gutters and above the stage's bottom, and scrolls inside
 *    when the list is taller than that.
 *  Every count is the caller's faceted "what you'd get" number for the visible band (own dimension released); "—" while
 *  the feed loads. A small Clear shows only when a filter is off its default. The component is pure — it only reports
 *  the next Filters. Layout is the parent's CSS: under the phone's search pill two 44 px rows — Show across the width,
 *  then When, Type and Clear (labels visually hidden but still the accessible names; nothing scrolls sideways, so
 *  nothing is ever off-screen — the one-row version hid Type past the edge). There When is as wide as its chosen
 *  option (measured here; "Custom range…" was cut to "Custo…" in a fixed share) and Type takes the
 *  rest; while Custom range… is chosen a third row holds From, To and Clear. In `.street-panel` (desktop, `panel`)
 *  labelled rows with the dates under When and Clear under them all. The DOM order is the order seen in each layout,
 *  so the tab order is too. */

export interface StreetFiltersProps {
  filters: Filters;
  /** facetCounts(...) for the visible band; null while the feed loads → counts read "—". */
  counts: FacetCounts | null;
  /** A window is loading (the previous counts stay on screen). */
  loading: boolean;
  /** Feed failed with nothing loaded: the Show radios stay named and focusable but aria-disabled and inert; the other controls are disabled. */
  disabled?: boolean;
  /** The desktop panel's layout: the custom range's dates under When (on the phone they are the third row, after Clear). */
  panel?: boolean;
  onChange: (next: Filters) => void;
}

type Show = 'all' | 'open' | 'closed';
const SHOWS: Show[] = ['all', 'open', 'closed'];
const WINDOWS: Window[] = [1, 7, 30, 90];
const CUSTOM = 'custom';
const DASH = '—';
/** The Type dialog: at most this wide, this far from the screen's edges and from its button. */
const POP_W = 320, EDGE = 12, GAP = 6;
/** The phone's When select is never wider than this share of the row (Type and Clear keep the rest). */
const WHEN_MAX = 0.52;
let measureCtx: CanvasRenderingContext2D | null = null;

export default function StreetFilters({ filters, counts, loading, disabled = false, panel = false, onChange }: StreetFiltersProps) {
  const t = useT();
  const id = useId();
  const row = useRef<HTMLDivElement>(null);
  const whenRef = useRef<HTMLSelectElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  const show = (n: number | undefined): string => (counts && n != null ? String(n) : DASH);
  const name = (label: string, n: number | undefined): string => (counts && n != null ? `${label}, ${n}` : label);

  const status: Show = filters.s ?? 'all';
  // "All" counts both statuses (status released, type + window applied); the Type dialog's "All types" is counts.all.
  const n: Record<Show, number | undefined> = { all: counts ? counts.open + counts.closed : undefined, open: counts?.open, closed: counts?.closed };
  const label: Record<Show, string> = { all: t('street.filter.all'), open: t('street.open'), closed: t('street.closed') };
  const active = filters.s != null || filters.g.length > 0 || filters.range != null || filters.d !== DEFAULT_FILTERS.d;

  // The Type button: the first picked group by name, "+n" for the rest; the count is what the view shows by type (the
  // groups are disjoint, so the union is the sum).
  const picked = filters.g;
  const typeN = !counts ? undefined : picked.length ? picked.reduce((a, g) => a + (counts.groups[g] ?? 0), 0) : counts.all;
  const typeName = picked.length === 0 ? t('street.filter.allTypes')
    : picked.length === 1 ? t(`group.${picked[0]}`)
    : t('street.filter.typesMore', { name: t(`group.${picked[0]}`), n: picked.length - 1 });

  function setStatus(s: Show) {
    if (disabled) return;
    const next = s === 'all' ? null : s;
    if (next !== filters.s) onChange({ ...filters, s: next });
  }
  function toggleGroup(g: GroupKey) {
    const has = filters.g.includes(g);
    onChange({ ...filters, g: GROUP_ORDER.filter((k) => (k === g ? !has : filters.g.includes(k))) });
  }
  function allTypes() { if (filters.g.length) onChange({ ...filters, g: [] }); }
  function setWindow(raw: string) {
    if (raw === CUSTOM) { if (!filters.range) onChange({ ...filters, range: defaultRange(Date.now()) }); return; }
    const d = WINDOWS.find((w) => String(w) === raw) ?? DEFAULT_FILTERS.d;
    if (d !== filters.d || filters.range) onChange({ ...filters, d, range: null });
  }
  function clear() {
    if (disabled) return;
    // Clear goes away with the filters it cleared: keep focus in the controls (on the now-checked "All") rather than <body>.
    const had = document.activeElement instanceof HTMLElement && document.activeElement.classList.contains('street-clear');
    setOpen(false);
    onChange({ ...filters, g: [], s: null, d: DEFAULT_FILTERS.d, range: null });
    // "All" by value, not :checked — the filters live in the URL, which commits after this frame.
    if (had) requestAnimationFrame(() => row.current?.querySelector<HTMLInputElement>('.street-seg-input[value="all"]')?.focus());
  }

  /* ── Custom range: From / To ─────────────────────────────────────────────────────────────────── */
  const range = filters.range;
  const bounds = rangeBounds(Date.now());
  // Each box's bounds: today − 89 … today, and the other applied date.
  const lim = {
    from: { min: bounds.min, max: range && range.to < bounds.max ? range.to : bounds.max },
    to: { min: range && range.from > bounds.min ? range.from : bounds.min, max: bounds.max },
  };
  // What the inputs show while a typed date is not applied (or not in the URL) yet; null = the applied range.
  const [draft, setDraft] = useState<{ from: string; to: string } | null>(null);
  useEffect(() => { setDraft(null); }, [range?.from, range?.to]);
  function setDate(which: 'from' | 'to', v: string) {
    if (!range) return;
    if (!isYmd(v) || v < lim[which].min || v > lim[which].max) { setDraft({ ...(draft ?? range), [which]: v }); return; }
    // The other date is held to the bounds too (they move on at midnight while the page stays open).
    const next = clampRange({ ...range, [which]: v }, Date.now()) ?? range;
    // Shown as typed until the URL has it: writing the box's value meanwhile would restart the browser's segment (the
    // "8" of "28" typed into a day would make it the 8th).
    setDraft(next);
    if (next.from !== range.from || next.to !== range.to) onChange({ ...filters, range: next });
  }

  /* ── The phone's When width: its chosen option's text + the select's padding and border ─────────── */
  const [fontsTick, setFontsTick] = useState(0);
  useEffect(() => { let live = true; document.fonts?.ready.then(() => { if (live) setFontsTick((x) => x + 1); }); return () => { live = false; }; }, []);
  useLayoutEffect(() => {
    const el = whenRef.current, box = row.current;
    if (!el || !box) return;
    if (panel) { el.style.width = ''; return; }
    measureCtx ??= document.createElement('canvas').getContext('2d');
    if (!measureCtx) return;
    const cs = getComputedStyle(el);
    measureCtx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const chrome = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
    const text = measureCtx.measureText(el.selectedOptions[0]?.text ?? '').width;
    el.style.width = `${Math.min(Math.ceil(text + chrome + 2), Math.floor(box.clientWidth * WHEN_MAX))}px`;
  }, [panel, range != null, filters.d, t, fontsTick]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── The Type dialog ─────────────────────────────────────────────────────────────────────────── */
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  };
  if (disabled && open) setOpen(false);
  useLayoutEffect(() => {
    if (!open) return;
    const btn = btnRef.current, pop = popRef.current;
    if (!btn || !pop) return;
    // Under the button (above it when there is clearly more room there), right edges aligned, inside the gutters; never
    // past the stage's bottom (the phone's tab bar) or the window's. Placed at 0,0 first to read where the fixed box's
    // origin really is (a containing ancestor would offset it), then moved by the difference.
    const place = () => {
      const r = btn.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const stage = btn.closest('.street-stage')?.getBoundingClientRect();
      const bottom = Math.min(window.innerHeight, stage?.bottom ?? window.innerHeight) - EDGE;
      const top = Math.max(0, stage?.top ?? 0) + EDGE;
      const w = Math.min(POP_W, vw - 2 * EDGE);
      const left = Math.min(Math.max(EDGE, r.right - w), vw - EDGE - w);
      const below = bottom - (r.bottom + GAP), above = r.top - GAP - top;
      const down = below >= 240 || below >= above;
      pop.style.width = `${w}px`;
      pop.style.maxHeight = `${Math.max(0, down ? below : above)}px`;
      pop.style.left = '0px'; pop.style.top = '0px';
      const o = pop.getBoundingClientRect();
      pop.style.left = `${left - o.left}px`;
      pop.style.top = `${(down ? r.bottom + GAP : r.top - GAP - o.height) - o.top}px`;
    };
    place();
    pop.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(true); } };
    // An outside tap closes it. Focus goes back to the button only when it was in the dialog and the tap did not take
    // it somewhere itself (an input, the map) — checked after this event's own mousedown focus change.
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target || pop.contains(target) || btn.contains(target)) return;
      const wasInside = pop.contains(document.activeElement);
      close(false);
      if (!wasInside) return;
      window.setTimeout(() => {
        const a = document.activeElement;
        if (!a || a === document.body || !a.isConnected) btnRef.current?.focus();
      }, 0);
    };
    // The panel scrolls (desktop) and the phone rotates: follow the button. Its own list scrolling is not a move.
    const onScroll = (e: Event) => { if (!(e.target instanceof Node && pop.contains(e.target))) place(); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', place);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // Focus left the button + dialog for another control (Tab past Done, Shift+Tab past the button): close, no refocus.
  // A null relatedTarget (the window lost focus, a tap on plain text — onDown handles that) leaves it open.
  const onTypeBlur = (e: FocusEvent<HTMLDivElement>) => {
    const to = e.relatedTarget;
    if (open && to instanceof Node && !e.currentTarget.contains(to)) close(false);
  };

  const dis = disabled || undefined;
  const clearBtn = active && (
    <button type="button" className="street-clear" aria-label={t('street.filter.clear')} aria-disabled={dis} onClick={clear}>{t('street.filter.clearShort')}</button>
  );
  const date = (which: 'from' | 'to') => (
    <div className="street-date">
      <label className="street-date-label" htmlFor={`${id}-${which}`}>{t(`street.filter.${which}`)}</label>
      <input id={`${id}-${which}`} type="date" className="street-date-input" required min={lim[which].min} max={lim[which].max} disabled={disabled}
        value={(draft ?? range)?.[which] ?? ''} onChange={(e) => setDate(which, e.target.value)} onBlur={() => setDraft(null)} />
    </div>
  );
  const rangeRow = range && (
    <div className="street-range" role="group" aria-label={t('street.filter.range')}>
      {date('from')}
      {date('to')}
    </div>
  );
  const check = (key: string, text: string, count: number | undefined, checked: boolean, onToggle: () => void) => (
    <li key={key}>
      <label className="street-check" data-group={key}>
        <input type="checkbox" checked={checked} aria-label={name(text, count)} onChange={onToggle} />
        <span className="street-check-name" aria-hidden="true">{text}</span>
        <span className="street-check-n" aria-hidden="true">{show(count)}</span>
      </label>
    </li>
  );

  return (
    <div ref={row} className={`street-filters${range ? ' has-range' : ''}`} aria-busy={loading || undefined}>
      <fieldset className="street-filter street-filter--show">
        <legend className="street-filter-label">{t('street.filter.show')}</legend>
        <div className="street-seg">
          {SHOWS.map((s) => (
            <label key={s} className="street-seg-opt" data-show={s}>
              <input type="radio" className="street-seg-input" name={`${id}-show`} value={s} checked={status === s}
                aria-label={name(label[s], n[s])} aria-disabled={dis} onChange={() => setStatus(s)} />
              <span className="street-seg-face">
                <span className="street-seg-name">
                  {s !== 'all' && <span className={`street-dot street-dot--${s}`} aria-hidden="true" />}
                  {label[s]}
                </span>
                <span className="street-seg-n">{show(n[s])}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="street-filter">
        <label className="street-filter-label" htmlFor={`${id}-when`}>{t('street.filter.when')}</label>
        <select ref={whenRef} id={`${id}-when`} className="street-select" value={range ? CUSTOM : String(filters.d)} disabled={disabled} onChange={(e) => setWindow(e.target.value)}>
          {WINDOWS.map((w) => <option key={w} value={String(w)}>{t(`street.days.${w}`)}</option>)}
          <option value={CUSTOM}>{t('street.days.custom')}</option>
        </select>
      </div>
      {panel && rangeRow}

      <div className={`street-filter street-filter--type${open ? ' is-open' : ''}`} onBlur={onTypeBlur}>
        <span id={`${id}-type-l`} className="street-filter-label">{t('street.filter.type')}</span>
        <button ref={btnRef} type="button" className="street-select street-type-btn" disabled={disabled}
          aria-labelledby={`${id}-type-l ${id}-type-v`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? `${id}-type-pop` : undefined}
          onClick={() => { if (open) close(true); else setOpen(true); }}>
          <span id={`${id}-type-v`} className="street-type-text">{`${typeName} · ${show(typeN)}`}</span>
        </button>
        {open && (
          <div ref={popRef} id={`${id}-type-pop`} className="street-type-pop" role="dialog" aria-label={t('street.filter.type')}>
            <ul className="street-checks">
              {check('all', t('street.filter.allTypes'), counts?.all, picked.length === 0, allTypes)}
              {GROUP_ORDER.map((g) => check(g, t(`group.${g}`), counts?.groups[g], picked.includes(g), () => toggleGroup(g)))}
            </ul>
            <div className="street-type-foot">
              <button type="button" className="btn btn-secondary street-type-done" onClick={() => close(true)}>{t('street.filter.done')}</button>
            </div>
          </div>
        )}
      </div>

      {!panel && rangeRow}
      {clearBtn}
    </div>
  );
}
