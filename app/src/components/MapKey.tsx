import { useEffect, useId, useRef, useState, type FocusEvent, type ReactNode } from 'react';
import { useT } from '../i18n';
import { track } from '../lib/analytics';
import { caseMarker, clusterMarker, homeMarker, type MarkerParts } from '../lib/mapMarkers';
import './StreetParts.css';

/** "Map key" (Rob, 2026-10-27: "figure out a way to document the legend"): a 44 px button over the map that opens a
 *  small non-modal dialog explaining every mark the map draws — open pin, closed pin, number circle, the type icon in a
 *  pin, the pulsing ring (new), the × pin, the dashed circle. Each swatch is drawn by lib/mapMarkers.ts, the same code
 *  MapView draws the map with, inside a `.map-pins` box so MapView.css styles both — the key can never drift from the
 *  map. Escape, the dialog's ×, the button again or a tap outside closes it; focus returns to the button (after an
 *  outside tap only when focus was still in the dialog). Tabbing out of it (to anything but the button) closes it too,
 *  focus staying where it went — on the phone it overlaps the sheet's header, and a control it covers must never take
 *  focus under it (WCAG 2.4.11). The swatches are decorative: each line names its mark in words
 *  ("Orange pin: …"), so the key also reads without colour. The parent positions it (`.street-key` in Street.css). */

export interface MapKeyProps {
  /** Show the label next to the icon (desktop); the phone shows the icon alone. The accessible name is the label either way. */
  withText?: boolean;
  /** Not rendered (the phone sheet at FULL covers its spot); an open key closes. */
  hidden?: boolean;
}

const KeyIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="6" cy="7" r="2.6" fill="var(--ember)" />
    <circle cx="6" cy="17" r="2.6" fill="var(--muted)" />
    <path d="M12 7h8M12 17h8" />
  </svg>
);

function Swatch({ m, extra = '', box }: { m: MarkerParts; extra?: string; box?: number }) {
  return (
    <span className={`street-key-swatch ${m.className}${extra ? ` ${extra}` : ''}`} style={{ width: box ?? m.size[0], height: box ?? m.size[1] }}
      dangerouslySetInnerHTML={{ __html: m.html }} />
  );
}

export default function MapKey({ withText = false, hidden = false }: MapKeyProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const popId = useId();
  const headId = useId();
  const label = t('street.key');

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  };

  if (hidden && open) setOpen(false); // hidden while open (the sheet went to FULL): it comes back closed
  useEffect(() => {
    if (!open) return;
    popRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(true); } };
    // An outside tap closes it. Focus goes back to the button only when it was in the dialog and the tap did not take
    // it somewhere itself (an input, the map) — checked after this event's own mousedown focus change.
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target || popRef.current?.contains(target) || btnRef.current?.contains(target)) return;
      const pop = popRef.current;
      const wasInside = !!pop && pop.contains(document.activeElement);
      close(false);
      if (!wasInside) return;
      window.setTimeout(() => {
        const a = document.activeElement;
        if (!a || a === document.body || !a.isConnected || pop.contains(a)) btnRef.current?.focus();
      }, 0);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown, true); };
  }, [open]);

  // Focus left the button + dialog for another control (Tab past the ×, Shift+Tab past the button): close, no refocus.
  // A null relatedTarget (the window lost focus, a tap on plain text — onDown handles that) leaves it open.
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const to = e.relatedTarget;
    if (open && to instanceof Node && !e.currentTarget.contains(to)) close(false);
  };

  if (hidden) return null;

  const entries: { key: string; swatch: ReactNode }[] = [
    { key: 'open', swatch: <Swatch m={caseMarker('streets', true)} /> },
    { key: 'closed', swatch: <Swatch m={caseMarker('streets', false)} /> },
    { key: 'cluster', swatch: <Swatch m={clusterMarker(8, 5 / 8)} box={40} /> },
    { key: 'type', swatch: <><Swatch m={caseMarker('trash', true)} /><Swatch m={caseMarker('lights', false)} /></> },
    { key: 'new', swatch: <Swatch m={caseMarker('streets', true, true)} extra="map-pin--halo" /> },
    { key: 'home', swatch: <Swatch m={homeMarker()} /> },
    { key: 'ring', swatch: <svg className="street-key-ring" width="40" height="40" viewBox="0 0 40 40"><circle className="map-ring" cx="20" cy="20" r="17" /></svg> },
  ];

  return (
    <div className={`street-key${open ? ' is-open' : ''}`} onBlur={onBlur}>
      <button ref={btnRef} type="button" className={`street-key-btn${withText ? ' street-key-btn--text' : ''}`} aria-label={label} title={withText ? undefined : label}
        aria-expanded={open} aria-controls={open ? popId : undefined}
        onClick={() => { if (open) close(true); else { setOpen(true); track('street_key'); } }}>
        {KeyIcon}{withText && <span>{label}</span>}
      </button>
      {open && (
        <div ref={popRef} id={popId} className="street-key-pop map-pins" role="dialog" aria-labelledby={headId} tabIndex={-1}>
          <div className="street-key-head">
            <h2 id={headId} className="street-key-title">{label}</h2>
            <button type="button" className="street-ico street-key-x" aria-label={t('street.key.close')} onClick={() => close(true)}><span aria-hidden="true">×</span></button>
          </div>
          <ul className="street-key-list">
            {entries.map((e) => (
              <li key={e.key} className="street-key-item" data-key={e.key}>
                <span className="street-key-sw" aria-hidden="true">{e.swatch}</span>
                <span className="street-key-text">{t(`street.key.${e.key}`)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
