import { useEffect, useRef } from 'react';
import { GROUP_ORDER } from '@shared/categories';
import { GROUP_ICON } from '../lib/categories';
import type { FacetCounts, Filters, Window } from '../lib/streetMap';
import { useT } from '../i18n';
import CategoryIcon from './CategoryIcon';
import './StreetParts.css';

/** The /street filter rail (spec: .claude/street-map-spec.md "filters"): Clear · Open n · Closed n · window select ·
 *  All n · ten group chips. Every count is the caller's faceted "what you'd get" number for the visible band (own
 *  dimension released); the rail itself is pure — it only reports the next Filters. On phones it scrolls horizontally
 *  under the search pill; inside `.street-panel` (desktop) it wraps instead. */

export interface StreetFiltersProps {
  filters: Filters;
  /** facetCounts(...) for the visible band; null while the feed loads → chips read "—". */
  counts: FacetCounts | null;
  /** A window is loading (the previous counts stay on screen). */
  loading: boolean;
  /** Feed failed with nothing loaded: chips stay named and focusable but aria-disabled and inert. */
  disabled?: boolean;
  onChange: (next: Filters) => void;
}

const WINDOWS: Window[] = [7, 30, 90];
const DASH = '—';

export default function StreetFilters({ filters, counts, loading, disabled = false, onChange }: StreetFiltersProps) {
  const t = useT();
  const rail = useRef<HTMLDivElement>(null);

  // A deep link (?g=animals) presses a chip past the right edge: bring it into view once, on mount.
  useEffect(() => {
    const el = rail.current?.querySelector<HTMLElement>('.street-chip-group[aria-pressed="true"]');
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, []);

  const show = (n: number | undefined): string => (counts && n != null ? String(n) : DASH);
  const name = (label: string, n: number | undefined): string => (counts && n != null ? `${label}, ${n}` : label);

  const openOn = filters.s !== 'closed';
  const closedOn = filters.s !== 'open';
  const active = filters.g != null || filters.s != null;

  /** Toggle one status chip. Turning off the last one is a no-op: status alone can never empty the map. */
  function toggleStatus(which: 'open' | 'closed') {
    if (disabled) return;
    const on = which === 'open' ? openOn : closedOn;
    const otherOn = which === 'open' ? closedOn : openOn;
    if (on && !otherOn) return;
    onChange({ ...filters, s: on ? (which === 'open' ? 'closed' : 'open') : null });
  }
  function setGroup(g: Filters['g']) {
    if (disabled) return;
    onChange({ ...filters, g: filters.g === g ? null : g });
  }
  function clear() {
    if (disabled) return;
    onChange({ ...filters, g: null, s: null });
  }
  function setWindow(raw: string) {
    const d = WINDOWS.find((w) => String(w) === raw) ?? 30;
    if (d !== filters.d) onChange({ ...filters, d });
  }

  const dis = disabled || undefined;

  return (
    <div ref={rail} className="street-rail" role="group" aria-label={t('street.filter.type')} aria-busy={loading || undefined}>
      {active && (
        <button type="button" className="chip street-chip street-clear" aria-disabled={dis} onClick={clear}>
          <span className="street-chip-x" aria-hidden="true">×</span>
          <span className="street-chip-label">{t('street.filter.clear')}</span>
        </button>
      )}

      <button type="button" className="chip street-chip street-chip-status" aria-pressed={openOn} aria-label={name(t('street.open'), counts?.open)} aria-disabled={dis} onClick={() => toggleStatus('open')}>
        <span className="street-chip-label">{t('street.open')}</span>
        <span className="street-chip-n">{show(counts?.open)}</span>
      </button>
      <button type="button" className="chip street-chip street-chip-status" aria-pressed={closedOn} aria-label={name(t('street.closed'), counts?.closed)} aria-disabled={dis} onClick={() => toggleStatus('closed')}>
        <span className="street-chip-label">{t('street.closed')}</span>
        <span className="street-chip-n">{show(counts?.closed)}</span>
      </button>

      <select className="chip street-window" aria-label={t('street.filter.window')} value={String(filters.d)} disabled={disabled} onChange={(e) => setWindow(e.target.value)}>
        {WINDOWS.map((w) => <option key={w} value={String(w)}>{t(`street.days.${w}`)}</option>)}
      </select>

      <button type="button" className="chip street-chip street-chip-all" aria-pressed={filters.g == null} aria-label={name(t('street.filter.all'), counts?.all)} aria-disabled={dis} onClick={() => { if (!disabled && filters.g != null) onChange({ ...filters, g: null }); }}>
        <span className="street-chip-label">{t('street.filter.all')}</span>
        <span className="street-chip-n">{show(counts?.all)}</span>
      </button>
      {GROUP_ORDER.map((g) => {
        const label = t(`street.g.${g}`);
        const n = counts?.groups[g];
        return (
          <button key={g} type="button" className="chip street-chip street-chip-group" data-group={g} aria-pressed={filters.g === g} aria-label={name(label, n)} aria-disabled={dis} onClick={() => setGroup(g)}>
            <CategoryIcon k={GROUP_ICON[g] ?? 'unsure'} size={18} />
            <span className="street-chip-label">{label}</span>
            <span className="street-chip-n">{show(n)}</span>
          </button>
        );
      })}
    </div>
  );
}
