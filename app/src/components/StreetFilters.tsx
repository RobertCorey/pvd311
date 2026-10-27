import { useId, useRef } from 'react';
import { GROUP_ORDER } from '@shared/categories';
import { DEFAULT_FILTERS, type FacetCounts, type Filters, type Window } from '../lib/streetMap';
import { useT } from '../i18n';
import './StreetParts.css';

/** The /street filters (spec: .claude/street-map-spec.md "filters"; Rob, 2026-10-27: "filters are confusing" — the old
 *  chip rail mixed two independent status toggles, a pick-one type rail and a chip-like select, all with the same
 *  "pressed" look). Now three controls, each one choice:
 *  - Show: All / Open / Closed — a segmented control built from a fieldset + legend and native radios (arrow keys move
 *    within it). Open and Closed carry a dot in the pin colours (ember / muted) so it doubles as the pins' legend
 *    (decorative: the names already say open / closed).
 *  - When: the window select (7 / 30 / 90 days).
 *  - Type: "All types · n", then every group in GROUP_ORDER as "Trash · n" — zero counts listed too (picking one leads
 *    to the counted empty state). Writes the same g= the old chips did.
 *  Every count is the caller's faceted "what you'd get" number for the visible band (own dimension released); "—" while
 *  the feed loads. A small Clear shows only when a filter is off its default. The component is pure — it only reports
 *  the next Filters. Layout is the parent's CSS: under the phone's search pill two 44 px rows — Show across the width,
 *  then When, Type and Clear (labels visually hidden but still the accessible names; nothing scrolls sideways, so
 *  nothing is ever off-screen — the one-row version hid Type past the edge); in `.street-panel` (desktop) three
 *  labelled rows with Clear under them. Clear is last in the DOM either way, so the tab order is what is seen. */

export interface StreetFiltersProps {
  filters: Filters;
  /** facetCounts(...) for the visible band; null while the feed loads → counts read "—". */
  counts: FacetCounts | null;
  /** A window is loading (the previous counts stay on screen). */
  loading: boolean;
  /** Feed failed with nothing loaded: the Show radios stay named and focusable but aria-disabled and inert; the selects are disabled. */
  disabled?: boolean;
  onChange: (next: Filters) => void;
}

type Show = 'all' | 'open' | 'closed';
const SHOWS: Show[] = ['all', 'open', 'closed'];
const WINDOWS: Window[] = [7, 30, 90];
const DASH = '—';
export default function StreetFilters({ filters, counts, loading, disabled = false, onChange }: StreetFiltersProps) {
  const t = useT();
  const id = useId();
  const row = useRef<HTMLDivElement>(null);

  const show = (n: number | undefined): string => (counts && n != null ? String(n) : DASH);
  const name = (label: string, n: number | undefined): string => (counts && n != null ? `${label}, ${n}` : label);
  const option = (label: string, n: number | undefined): string => `${label} · ${show(n)}`;

  const status: Show = filters.s ?? 'all';
  // "All" counts both statuses (status released, type + window applied); the Type select's "All types" is counts.all.
  const n: Record<Show, number | undefined> = { all: counts ? counts.open + counts.closed : undefined, open: counts?.open, closed: counts?.closed };
  const label: Record<Show, string> = { all: t('street.filter.all'), open: t('street.open'), closed: t('street.closed') };
  const active = filters.s != null || filters.g != null || filters.d !== DEFAULT_FILTERS.d;

  function setStatus(s: Show) {
    if (disabled) return;
    const next = s === 'all' ? null : s;
    if (next !== filters.s) onChange({ ...filters, s: next });
  }
  function setGroup(raw: string) {
    const g = GROUP_ORDER.find((x) => x === raw) ?? null;
    if (g !== filters.g) onChange({ ...filters, g });
  }
  function setWindow(raw: string) {
    const d = WINDOWS.find((w) => String(w) === raw) ?? DEFAULT_FILTERS.d;
    if (d !== filters.d) onChange({ ...filters, d });
  }
  function clear() {
    if (disabled) return;
    // Clear goes away with the filters it cleared: keep focus in the controls (on the now-checked "All") rather than <body>.
    const had = document.activeElement instanceof HTMLElement && document.activeElement.classList.contains('street-clear');
    onChange({ ...filters, g: null, s: null, d: DEFAULT_FILTERS.d });
    // "All" by value, not :checked — the filters live in the URL, which commits after this frame.
    if (had) requestAnimationFrame(() => row.current?.querySelector<HTMLInputElement>('.street-seg-input[value="all"]')?.focus());
  }

  const dis = disabled || undefined;
  const clearBtn = active && (
    <button type="button" className="street-clear" aria-label={t('street.filter.clear')} aria-disabled={dis} onClick={clear}>{t('street.filter.clearShort')}</button>
  );

  return (
    <div ref={row} className="street-filters" aria-busy={loading || undefined}>
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
        <select id={`${id}-when`} className="street-select" value={String(filters.d)} disabled={disabled} onChange={(e) => setWindow(e.target.value)}>
          {WINDOWS.map((w) => <option key={w} value={String(w)}>{t(`street.days.${w}`)}</option>)}
        </select>
      </div>

      <div className="street-filter">
        <label className="street-filter-label" htmlFor={`${id}-type`}>{t('street.filter.type')}</label>
        <select id={`${id}-type`} className="street-select" value={filters.g ?? ''} disabled={disabled} onChange={(e) => setGroup(e.target.value)}>
          <option value="">{option(t('street.filter.allTypes'), counts?.all)}</option>
          {GROUP_ORDER.map((g) => <option key={g} value={g}>{option(t(`street.g.${g}`), counts?.groups[g])}</option>)}
        </select>
      </div>

      {clearBtn}
    </div>
  );
}
