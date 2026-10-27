import { useT } from '../i18n';
import { ago, type MapCase } from '../lib/streetMap';
import CategoryIcon from './CategoryIcon';
import './StreetParts.css';

/** One city case in the /street list (spec: .claude/street-map-spec.md "a11y"): `<li class="street-row">` holding ONE
 *  `<button class="street-row-btn" aria-pressed>` whose content is spans only — a button may not contain block
 *  elements, so the resolution note is a `display:block` span here (the card uses a real blockquote). Classes keep the
 *  look rows had in Street.css: street-icon, street-main, street-type, street-addr, street-when, street-note, my-status. */

type T = ReturnType<typeof useT>;

/** Pill variant for a city status: closed-by-the-city is neutral ink, cancelled/merged muted, everything else "received". */
const pillKey = (s: string): string => (s === 'Resolved' || s === 'Closed' ? 'resolved' : s === 'Cancelled' || s === 'Merged' ? 'cityCancelled' : 'received');

/** "today" / "yesterday" / "3 days ago" for a date, '' when it will not parse (shared with /my's followed cases). */
export function agoText(t: T, iso: string | null, nowMs: number): string {
  const a = ago(iso, nowMs);
  if (a == null) return '';
  return a === 'today' ? t('street.ago.today') : a === 'yesterday' ? t('street.ago.yesterday') : t('street.ago.days', { n: a });
}

/** The city's status as the `.my-status` pill: `street.status.<status>` when we have a translation, else the raw string. */
export function StatusPill({ status }: { status: string }) {
  const t = useT();
  if (!status) return null;
  const key = `street.status.${status}`;
  const label = t(key) === key ? status : t(key);
  return <span className={`my-status my-status--${pillKey(status)}`}>{label}</span>;
}

/** "Reported 3 days ago" (open) / "Closed yesterday" (closed); nothing when the case carries no parseable date. */
export function WhenLine({ c, nowMs }: { c: MapCase; nowMs: number }) {
  const t = useT();
  const when = c.open ? agoText(t, c.createdAt, nowMs) : agoText(t, c.closedAt ?? c.createdAt, nowMs);
  if (!when) return null;
  return <span className="street-when">{c.open ? t('street.when.reported', { when }) : t('street.when.closed', { when })}</span>;
}

/** "10 Angell St · College Hill · 40 m away" — the hood is plain text (never a nested control); a blank street reads
 *  t('street.noStreet'); the distance appears only when the caller has a point. */
export function PlaceLine({ c, hood, distanceM }: { c: MapCase; hood?: string | null; distanceM?: number | null }) {
  const t = useT();
  const parts = [c.street || t('street.noStreet')];
  if (hood) parts.push(hood);
  if (distanceM != null) parts.push(t('street.distance', { m: distanceM }));
  return <span className="street-addr">{parts.join(' · ')}</span>;
}

export interface StreetRowProps {
  c: MapCase;
  /** Neighborhood name (caller's hoodOf lookup); shown after the street. */
  hood?: string | null;
  /** Metres from the home point; shown as "{m} m away" when set. */
  distanceM?: number | null;
  /** This row's case is the selected one (`aria-pressed`, pressed look). */
  selected?: boolean;
  onSelect: (id: string) => void;
  /** Desktop row hover ⇄ pin `.map-pin--hover`; also fires on keyboard focus/blur. */
  onHover?: (id: string | null) => void;
  nowMs: number;
  /** A small pill before the type — the landing's "New" (t('street.newTag')) on a case created since the last visit. One per row. */
  tag?: string;
}

export default function StreetRow({ c, hood, distanceM, selected = false, onSelect, onHover, nowMs, tag }: StreetRowProps) {
  const t = useT();
  const enter = onHover ? () => onHover(c.id) : undefined;
  const leave = onHover ? () => onHover(null) : undefined;
  return (
    <li className="street-row">
      <button
        type="button"
        className="street-row-btn"
        aria-pressed={selected}
        data-id={c.id}
        onClick={() => onSelect(c.id)}
        onMouseEnter={enter}
        onMouseLeave={leave}
        onFocus={enter}
        onBlur={leave}
      >
        <span className="street-icon"><CategoryIcon k={c.category} size={24} /></span>
        <span className="street-main">
          <span className="street-type">{tag && <span className="my-status my-status--new">{tag}</span>}{c.caseType || t(`street.g.${c.group}`)}</span>
          <PlaceLine c={c} hood={hood} distanceM={distanceM} />
          <WhenLine c={c} nowMs={nowMs} />
          {!c.open && c.resolution && <span className="street-note">{c.resolution}</span>}
        </span>
        <StatusPill status={c.status} />
      </button>
    </li>
  );
}
