import type { ReactNode } from 'react';

/**
 * Two-ink Providence scene illustrations (docs/design-direction.md, "Ember & Harbor").
 * Flat paths, no gradients, harbor ink + ember on paper. viewBox 260x160, aria-hidden.
 * A shared triple-decker / street-light / road kit is recomposed per empty state.
 */

const INK = 'var(--ink)';
const EMBER = 'var(--ember)';
const SURFACE = 'var(--surface)';
const LINE = 'var(--line)';

function Road({ centerLine = true }: { centerLine?: boolean }): ReactNode {
  return (
    <g>
      <rect x="0" y="132" width="260" height="28" fill={LINE} />
      <line x1="0" y1="132" x2="260" y2="132" stroke={INK} strokeWidth="2.5" />
      {centerLine && (
        <line x1="0" y1="147" x2="260" y2="147" stroke={EMBER} strokeWidth="3" strokeDasharray="14 12" strokeLinecap="round" />
      )}
    </g>
  );
}

/** Triple-decker: stacked porches on the left bay, three windows on the right; top window lit. */
function TripleDecker({ lit = true }: { lit?: boolean }): ReactNode {
  const rail = (y: number) => (
    <g stroke={INK} strokeWidth="1.6" strokeLinecap="round">
      <line x1="40" y1={y - 8} x2="68" y2={y - 8} />
      <line x1="40" y1={y} x2="68" y2={y} />
      <line x1="46" y1={y - 8} x2="46" y2={y} />
      <line x1="54" y1={y - 8} x2="54" y2={y} />
      <line x1="62" y1={y - 8} x2="62" y2={y} />
    </g>
  );
  const winRow = (y: number, on: boolean) => (
    <g stroke={INK} strokeWidth="2" strokeLinejoin="round">
      <rect x="80" y={y} width="20" height="16" fill={on ? EMBER : SURFACE} />
      <line x1="90" y1={y} x2="90" y2={y + 16} />
      <line x1="80" y1={y + 8} x2="100" y2={y + 8} />
    </g>
  );
  return (
    <g strokeLinejoin="round">
      <rect x="34" y="40" width="74" height="92" fill={SURFACE} stroke={INK} strokeWidth="2.5" />
      <path d="M30 40 L112 40 L104 26 L38 26 Z" fill={SURFACE} stroke={INK} strokeWidth="2.5" />
      <line x1="34" y1="71" x2="108" y2="71" stroke={INK} strokeWidth="1.5" />
      <line x1="34" y1="102" x2="108" y2="102" stroke={INK} strokeWidth="1.5" />
      <line x1="40" y1="40" x2="40" y2="132" stroke={INK} strokeWidth="2" />
      <line x1="68" y1="40" x2="68" y2="132" stroke={INK} strokeWidth="2" />
      {rail(66)}
      {rail(97)}
      {rail(128)}
      {winRow(48, lit)}
      {winRow(79, false)}
      {winRow(110, false)}
    </g>
  );
}

/** Cobra-head street light on a pole; optional ember glow cone. */
function StreetLight({ glow = true }: { glow?: boolean }): ReactNode {
  return (
    <g>
      {glow && <path d="M184 42 L212 120 L150 120 Z" fill={EMBER} fillOpacity="0.2" />}
      <line x1="224" y1="132" x2="224" y2="44" stroke={INK} strokeWidth="3" strokeLinecap="round" />
      <line x1="216" y1="132" x2="232" y2="132" stroke={INK} strokeWidth="3" strokeLinecap="round" />
      <path d="M224 44 Q224 36 214 36 L190 36" fill="none" stroke={INK} strokeWidth="3" strokeLinecap="round" />
      <path d="M172 32 H192 A3 3 0 0 1 195 35 V37 A3 3 0 0 1 192 41 H172 Z" fill={INK} />
    </g>
  );
}

/** Crow perched on a drooping wire. */
function CrowWire(): ReactNode {
  return (
    <g>
      <path d="M108 50 Q166 66 224 46" fill="none" stroke={INK} strokeWidth="1.5" />
      <path d="M158 61 Q160 55 167 56 L181 53 L173 61 Q166 65 160 63 Z" fill={INK} />
      <circle cx="157.5" cy="57.5" r="3.6" fill={INK} />
      <path d="M154 56 L149 57.5 L154 59 Z" fill={INK} />
      <path d="M161 63 L160 68 M165 63 L165 68" stroke={INK} strokeWidth="1.5" strokeLinecap="round" />
    </g>
  );
}

const POTHOLE = 'M138 140 L147 136 L156 140 L166 135 L177 138 L185 141 L176 147 L164 145 L152 148 L143 146 Z';

function Pothole(): ReactNode {
  return (
    <g>
      <path d={POTHOLE} transform="translate(2.5 2.5)" fill={EMBER} />
      <path d={POTHOLE} fill="none" stroke={INK} strokeWidth="2.5" strokeLinejoin="round" />
    </g>
  );
}

function scene(kind: string): ReactNode {
  switch (kind) {
    case 'empty':
      return (
        <>
          <Road centerLine={false} />
          <TripleDecker lit />
          <StreetLight glow={false} />
          <CrowWire />
          {/* calm: an empty signpost where the trouble would be */}
          <g strokeLinejoin="round">
            <line x1="150" y1="132" x2="150" y2="94" stroke={INK} strokeWidth="3" strokeLinecap="round" />
            <rect x="124" y="84" width="52" height="26" rx="3" fill={SURFACE} stroke={INK} strokeWidth="2.5" />
            <line x1="134" y1="97" x2="166" y2="97" stroke={LINE} strokeWidth="3" strokeLinecap="round" />
          </g>
        </>
      );
    case 'lost':
      return (
        <>
          {/* wandering dotted road */}
          <path
            d="M8 142 Q54 96 104 120 Q150 140 196 104 Q222 84 252 96"
            fill="none"
            stroke={INK}
            strokeWidth="2.5"
            strokeDasharray="1 11"
            strokeLinecap="round"
          />
          {/* dropped map pin with a question mark */}
          <circle cx="136" cy="50" r="24" fill={EMBER} />
          <path
            d="M130 22 A26 26 0 0 0 104 48 C104 72 130 102 130 102 C130 102 156 72 156 48 A26 26 0 0 0 130 22 Z"
            fill={SURFACE}
            stroke={INK}
            strokeWidth="3"
            strokeLinejoin="round"
          />
          <path
            d="M122 42 Q122 32 131 32 Q141 32 141 42 Q141 49 132 51 Q130 52 130 57 M130 66 h0.1"
            fill="none"
            stroke={INK}
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );
    case 'resolved':
      return (
        <>
          <Road centerLine={false} />
          <TripleDecker lit={false} />
          {/* patched square (hatched) where the pothole was */}
          <g>
            <rect x="128" y="134" width="52" height="22" fill={INK} fillOpacity="0.12" stroke={INK} strokeWidth="2.5" />
            <path
              d="M132 152 L148 134 M142 156 L164 134 M154 156 L176 134 M166 156 L180 140"
              stroke={INK}
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </g>
          {/* checkmark flag planted in the patch */}
          <g strokeLinejoin="round">
            <line x1="150" y1="134" x2="150" y2="104" stroke={INK} strokeWidth="2.5" strokeLinecap="round" />
            <path d="M150 104 H174 L167 111 L174 118 H150 Z" fill={EMBER} stroke={INK} strokeWidth="2" />
            <path d="M154 111 L158 115 L167 106" fill="none" stroke={INK} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </g>
        </>
      );
    case 'street':
    default:
      return (
        <>
          <Road />
          <TripleDecker lit />
          <StreetLight glow />
          <Pothole />
          <CrowWire />
        </>
      );
  }
}

export default function Illustration({
  kind,
  className,
}: {
  kind: 'street' | 'empty' | 'lost' | 'resolved';
  className?: string;
}) {
  return (
    <svg viewBox="0 0 260 160" className={className} aria-hidden="true" fill="none">
      {scene(kind)}
    </svg>
  );
}
