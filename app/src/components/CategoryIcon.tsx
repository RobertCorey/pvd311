import type { ReactNode } from 'react';
import { GROUP_ICON, groupOf } from '../lib/categories';

/**
 * Duotone "riso" category icons on a 32 grid (docs/design-direction.md, "Ember & Harbor").
 * Each icon is an ember "plate" — flat fill(s), offset ~1.4px down-right (the misregistration tell) —
 * sitting BEHIND confident harbor-ink line art. Ember group sets fill=var(--ember); the ink line art
 * inherits stroke=currentColor / fill=none from the <svg>. Built to read at 22px and shine at 44px.
 */
const PLATE = 'translate(1.4 1.4)';

const ICONS: Record<string, ReactNode> = {
  // Jagged hole in the road with an ember shadow pooled inside it.
  pothole: (
    <>
      <g fill="var(--ember)" stroke="none" transform={PLATE}>
        <path d="M9 14 L11 19.5 L14 22.5 L18 22.5 L21 19.5 L23 14 Z" />
      </g>
      <path d="M2 14 H9 L11 19.5 L14 22.5 H18 L21 19.5 L23 14 H30" />
      <path d="M4 27 H11 M21 27 H28" />
      <path d="M9 14 L7 9.5 M23 14 L25.5 9.5 M16 22.5 V26" />
    </>
  ),

  // Cobra-head lamp on a pole; ember plate is the lamp head, short ticks = a flickering/dead bulb.
  street_light: (
    <>
      <g fill="var(--ember)" stroke="none" transform={PLATE}>
        <path d="M18 4 H27 A2 2 0 0 1 29 6 V8 A2 2 0 0 1 27 10 H18 Z" />
      </g>
      <path d="M9 29 V9" />
      <path d="M4 29 H14" />
      <path d="M9 9 Q9 5 13 5 H18" />
      <path d="M18 4 H27 A2 2 0 0 1 29 6 V8 A2 2 0 0 1 27 10 H18 Z" />
      <path d="M23.5 13 V16 M19 12.5 L17.5 15 M28 12.5 L29.5 15" />
    </>
  ),

  // City wheelie cart, side profile; ember plate is the cart body.
  missed_trash: (
    <>
      <g fill="var(--ember)" stroke="none" transform={PLATE}>
        <path d="M9 12 L10.5 26 H21.5 L23 12 Z" />
      </g>
      <path d="M8 12 H24 L23 9 H9 Z" />
      <path d="M13 9 V6.5 H19 V9" />
      <path d="M9 12 L10.5 26 H21.5 L23 12" />
      <path d="M13.6 15 V23 M18.4 15 V23" />
      <circle cx="11" cy="27.4" r="1.6" />
      <circle cx="21" cy="27.4" r="1.6" />
    </>
  ),

  // A dumped heap: mound + a discarded box + a tire.
  illegal_dumping: (
    <>
      <g fill="var(--ember)" stroke="none" transform={PLATE}>
        <path d="M5 26 Q6 18 12 18 Q13 13 18 15 Q24 13 25 20 Q28 21 27 26 Z" />
      </g>
      <path d="M3 26 H29" />
      <path d="M5 26 Q6 18 12 18 Q13 13 18 15 Q24 14 25 20" />
      <path d="M13 19 L18 17 L19.5 20.5 L14.5 22.5 Z" />
      <circle cx="22" cy="22.5" r="2.6" />
      <circle cx="22" cy="22.5" r="0.7" />
    </>
  ),

  // Boxy sedan; ember plate is the body mass.
  abandoned_vehicle: (
    <>
      <g fill="var(--ember)" stroke="none" transform={PLATE}>
        <path d="M4 19 L7 13 Q7.5 12 9 12 L23 12 Q24.5 12 25 13 L28 19 Z" />
      </g>
      <path d="M3 20 L3 16 Q3 14 6 14 L9 14 L12 8.5 Q12.5 8 13.5 8 L18.5 8 Q19.5 8 20 8.5 L23 14 L26 14 Q29 14 29 16 L29 20 L25 20 A2.7 2.7 0 0 1 19.6 20 L12.4 20 A2.7 2.7 0 0 1 7 20 L3 20 Z" />
      <path d="M12 8.5 L10 14 M20 8.5 L22 14 M16 8 V14" />
      <circle cx="9.7" cy="20" r="2.5" />
      <circle cx="22.3" cy="20" r="2.5" />
    </>
  ),

  // Parking sign: ember sign face, ink "P" and post on top.
  parking: (
    <>
      <g fill="var(--ember)" stroke="none" transform={PLATE}>
        <rect x="7" y="4" width="18" height="18" rx="3" />
      </g>
      <path d="M16 22 V30" />
      <path d="M13 30 H19" />
      <rect x="7" y="4" width="18" height="18" rx="3" />
      <path d="M13 18 V8 H17 A3 3 0 0 1 17 14 H13" />
    </>
  ),

  // Two carts side by side (bins & carts, plural).
  bins_carts: (
    <>
      <g fill="var(--ember)" stroke="none" transform={PLATE}>
        <path d="M6 13 H14 L13 26 H7 Z" />
        <path d="M18 13 H26 L25 26 H19 Z" />
      </g>
      <path d="M5 13 H15 L14 10 H6 Z" />
      <path d="M6 13 L7 26 H13 L14 13" />
      <path d="M17 13 H27 L26 10 H18 Z" />
      <path d="M18 13 L19 26 H25 L26 13" />
    </>
  ),

  // Paw print; ember plate is the pads.
  animal_control: (
    <>
      <g fill="var(--ember)" stroke="none" transform={PLATE}>
        <ellipse cx="8.5" cy="13" rx="2" ry="2.7" />
        <ellipse cx="13.5" cy="10" rx="2" ry="2.9" />
        <ellipse cx="18.5" cy="10" rx="2" ry="2.9" />
        <ellipse cx="23.5" cy="13" rx="2" ry="2.7" />
        <path d="M16 27 C11 27 8.5 24.5 8.5 21.5 C8.5 18.5 11.5 17 16 17 C20.5 17 23.5 18.5 23.5 21.5 C23.5 24.5 21 27 16 27 Z" />
      </g>
      <ellipse cx="8.5" cy="13" rx="2" ry="2.7" />
      <ellipse cx="13.5" cy="10" rx="2" ry="2.9" />
      <ellipse cx="18.5" cy="10" rx="2" ry="2.9" />
      <ellipse cx="23.5" cy="13" rx="2" ry="2.7" />
      <path d="M16 27 C11 27 8.5 24.5 8.5 21.5 C8.5 18.5 11.5 17 16 17 C20.5 17 23.5 18.5 23.5 21.5 C23.5 24.5 21 27 16 27 Z" />
    </>
  ),

  // Speaker with ember sound-wave crescents.
  noise: (
    <>
      <g fill="var(--ember)" stroke="none" transform={PLATE}>
        <path d="M18.47 11.86 A5.4 5.4 0 0 1 18.47 20.14 L17.57 19.06 A4 4 0 0 0 17.57 12.94 Z" />
        <path d="M20.35 10.06 A8 8 0 0 1 20.35 21.94 L19.42 20.9 A6.6 6.6 0 0 0 19.42 11.1 Z" />
      </g>
      <path d="M4 13 H8 L13 8 V24 L8 19 H4 Z" />
    </>
  ),

  // Snow drift on a sidewalk slab, with a falling flake.
  unshoveled_sidewalk: (
    <>
      <g fill="var(--ember)" stroke="none" transform={PLATE}>
        <path d="M9 20 Q11 16 15 17 Q19 15.5 22 17.5 Q23.5 18.5 23 20 Z" />
      </g>
      <path d="M9 20 H23 L26 25 H6 Z" />
      <path d="M13 20 L11.5 25 M19 20 L20.5 25" />
      <path d="M9 20 Q11 16 15 17 Q19 15.5 22 17.5 Q23.5 18.5 23 20" />
      <path d="M16 4 V11 M12.7 6 L19.3 9 M19.3 6 L12.7 9" />
    </>
  ),

  // Plow truck on an unplowed, snow-drifted road.
  missed_plowing: (
    <>
      <g fill="var(--ember)" stroke="none" transform={PLATE}>
        <path d="M3 24 Q8 22.5 14 23 Q20 23.5 24 21 Q27 19 29 24 Z" />
      </g>
      <path d="M3 24 H29" />
      <path d="M4 22 L4 13 L13 13 L13 15 L18 15 L20 19 L20 22 Z" />
      <path d="M20 17.5 L25 15.5 L25 22 L23 22 L23 18.5 L21 19.3 Z" />
      <circle cx="8" cy="22" r="2.2" />
      <circle cx="16.5" cy="22" r="2.2" />
    </>
  ),

  // Speech bubble with a question mark; ember plate is the bubble.
  unsure: (
    <>
      <g fill="var(--ember)" stroke="none" transform={PLATE}>
        <path d="M6 6 H26 A2 2 0 0 1 28 8 V18 A2 2 0 0 1 26 20 H13 L8 25 V20 H6 A2 2 0 0 1 4 18 V8 A2 2 0 0 1 6 6 Z" />
      </g>
      <path d="M6 6 H26 A2 2 0 0 1 28 8 V18 A2 2 0 0 1 26 20 H13 L8 25 V20 H6 A2 2 0 0 1 4 18 V8 A2 2 0 0 1 6 6 Z" />
      <path d="M13 11 Q13 8.2 16 8.2 Q19.4 8.2 19.4 11 Q19.4 13.4 16.5 14.4 Q16 14.7 16 16 M16 18.8 h0.01" />
    </>
  ),

  // Ellipsis: ember discs offset behind ink rings.
  // Spray can with an ember tag swash on the wall.
  graffiti: (
    <>
      <g fill="var(--ember)" stroke="none" transform={PLATE}>
        <path d="M15 18 q4 -6 9 -2 q3 3 -1 6 q-5 3 -8 -4z" />
      </g>
      <path d="M6 12 h7 v16 h-7z" />
      <path d="M8 12 V9 h3 v3" />
      <path d="M9.5 6 V9" />
      <path d="M12 6 h3" />
      <path d="M16 20 q4 -6 9 -2 q3 3 -1 6" />
    </>
  ),

  // Cracked sidewalk slab, heaved; ember plate is the lifted slab.
  sidewalk_repair: (
    <>
      <g fill="var(--ember)" stroke="none" transform={PLATE}>
        <path d="M4 22 L14 18 L16 23 L4 26z" />
      </g>
      <path d="M3 26 H29" />
      <path d="M4 22 L14 18 L16 23" />
      <path d="M16 23 L28 22" />
      <path d="M14 18 L12 13 M14 18 L18 14" />
      <path d="M8 22 L9 24 M22 22 L23 24" />
    </>
  ),

  // Tree with a snapped limb; ember canopy plate.
  tree: (
    <>
      <g fill="var(--ember)" stroke="none" transform={PLATE}>
        <circle cx="16" cy="11" r="7" />
      </g>
      <path d="M16 29 V18" />
      <path d="M9 12 a7 7 0 1 1 14 0 a5 5 0 0 1 -4 6 H13 a5 5 0 0 1 -4 -6z" />
      <path d="M20 17 L26 22 M24 19 L23 23" />
      <path d="M11 29 h10" />
    </>
  ),

  // Water over the road: ember pool plate, wave lines, a submerged sign.
  street_flooding: (
    <>
      <g fill="var(--ember)" stroke="none" transform={PLATE}>
        <path d="M3 22 q4 -3 8 0 t8 0 t8 0 v5 H3z" />
      </g>
      <path d="M3 21 q4 -3 8 0 t8 0 t8 0" />
      <path d="M3 26 q4 -3 8 0 t8 0 t8 0" />
      <path d="M16 17 V8 M12 8 h8 v5 h-8z" />
    </>
  ),

  // Traffic signal: housing in ink, ember plate behind, the red light filled.
  traffic_signal: (
    <>
      <g fill="var(--ember)" stroke="none" transform={PLATE}>
        <rect x="11" y="4" width="10" height="20" rx="3" />
      </g>
      <rect x="11" y="4" width="10" height="20" rx="3" />
      <circle cx="16" cy="9" r="2" fill="currentColor" stroke="none" />
      <circle cx="16" cy="14.5" r="2" />
      <circle cx="16" cy="20" r="2" />
      <path d="M16 24 V29 M12 29 h8" />
    </>
  ),

  // Dead animal: quiet — paw print on a small mound, ember plate is the mound.
  dead_animal: (
    <>
      <g fill="var(--ember)" stroke="none" transform={PLATE}>
        <path d="M5 26 q11 -10 22 0z" />
      </g>
      <path d="M3 27 H29" />
      <path d="M5 26 q11 -10 22 0" />
      <circle cx="13" cy="12" r="1.6" /><circle cx="17.5" cy="10.5" r="1.6" /><circle cx="22" cy="12" r="1.6" />
      <path d="M14 19 q3.5 -4 7 0 q2 3 -1.5 3.5 h-4 q-3.5 -0.5 -1.5 -3.5z" />
    </>
  ),

  // Trash bag at a fence line: ember bag plate, fence pickets.
  trash_private: (
    <>
      <g fill="var(--ember)" stroke="none" transform={PLATE}>
        <path d="M18 14 q6 0 7 7 v6 H12 v-6 q0 -7 6 -7z" />
      </g>
      <path d="M18 13 q6 0 7 7 v7 H12 v-7 q0 -7 6 -7z M16 13 l2 -4 l2 4" />
      <path d="M3 27 V15 M7 27 V15 M3 19 h4" />
    </>
  ),
  // Litter on the curb: ember can plate, scattered pieces, curb line.
  trash_public: (
    <>
      <g fill="var(--ember)" stroke="none" transform={PLATE}>
        <path d="M9 12 h8 l-1 12 H10z" />
      </g>
      <path d="M9 11 h8 l-1 13 H10z M8 11 h10 M12 8 h2" />
      <path d="M21 20 l4 -2 M22 25 l5 1 M20 15 l3 -3" />
      <path d="M3 28 h26" />
    </>
  ),
  // Storm grate with water pooling: ember pool plate, grate bars.
  storm_drain: (
    <>
      <g fill="var(--ember)" stroke="none" transform={PLATE}>
        <path d="M3 18 q4 -3 8 0 t8 0 t8 0 v3 H3z" />
      </g>
      <rect x="6" y="20" width="20" height="8" rx="1.5" />
      <path d="M10 20 v8 M14 20 v8 M18 20 v8 M22 20 v8" />
      <path d="M3 16 q4 -3 8 0 t8 0 t8 0" />
    </>
  ),
  // Bent stop sign on a post: ember octagon plate.
  traffic_sign: (
    <>
      <g fill="var(--ember)" stroke="none" transform={PLATE}>
        <path d="M12 4 h8 l5 5 v8 l-5 5 h-8 l-5 -5 V9z" />
      </g>
      <path d="M12 4 h8 l5 5 v8 l-5 5 h-8 l-5 -5 V9z" />
      <path d="M16 22 v3 l-3 4" />
      <path d="M11 13 h10" />
    </>
  ),
  // Traffic cone with a speed streak: ember cone plate.
  traffic_control: (
    <>
      <g fill="var(--ember)" stroke="none" transform={PLATE}>
        <path d="M14 5 h4 l4 20 H10z" />
      </g>
      <path d="M14 4 h4 l4 21 H10z M12 14 h8 M7 25 h18" />
      <path d="M26 9 h3 M25 13 h4" />
    </>
  ),
  // Tall grass at a fence: ember tuft plate.
  overgrowth: (
    <>
      <g fill="var(--ember)" stroke="none" transform={PLATE}>
        <path d="M6 27 q2 -12 6 -14 q-1 8 2 14z M14 27 q1 -14 6 -18 q0 10 2 18z" />
      </g>
      <path d="M5 27 q2 -12 6 -14 q-1 8 2 14 M13 27 q1 -14 6 -18 q0 10 2 18 M21 27 q0 -8 5 -11 q-2 6 0 11" />
      <path d="M3 28 h26" />
    </>
  ),
  // Leaning pole with a dropped wire: ember spark plate at the wire end.
  downed_wire: (
    <>
      <g fill="var(--ember)" stroke="none" transform={PLATE}>
        <circle cx="24" cy="24" r="4" />
      </g>
      <path d="M9 28 L13 5 M9 10 h10 M10 14 h8" />
      <path d="M17 9 q4 6 6 14" />
      <path d="M22 20 l2 -3 M26 22 l3 -2 M25 27 l3 2" />
    </>
  ),
  // House with an ember roof plate; a small window + door. Group tile for Buildings & property.
  property: (
    <>
      <g fill="var(--ember)" stroke="none" transform={PLATE}>
        <path d="M5 15 L16 5 L27 15 H5 Z" />
      </g>
      <path d="M5 15 L16 5 L27 15" />
      <path d="M8 13 V27 H24 V13" />
      <path d="M14 27 V20 H18 V27" />
      <path d="M11 17 H13 M19 17 H21" />
    </>
  ),

  // Fire hydrant, ember barrel plate; two side nozzles and a cap. Group tile for Water, sewer & gas.
  water: (
    <>
      <g fill="var(--ember)" stroke="none" transform={PLATE}>
        <rect x="11" y="10" width="10" height="15" rx="2" />
      </g>
      <path d="M11 10 H21 V25 H11 Z" />
      <path d="M13 10 V7 A3 3 0 0 1 19 7 V10" />
      <path d="M9 7 H23" />
      <path d="M8 25 H24 M9 28 H23" />
      <path d="M6 16 H11 M21 16 H26" />
      <path d="M6 14 V18 M26 14 V18" />
    </>
  ),

  other: (
    <>
      <g fill="var(--ember)" stroke="none" transform={PLATE}>
        <circle cx="8" cy="16" r="2.4" />
        <circle cx="16" cy="16" r="2.4" />
        <circle cx="24" cy="16" r="2.4" />
      </g>
      <circle cx="8" cy="16" r="2.4" />
      <circle cx="16" cy="16" r="2.4" />
      <circle cx="24" cy="16" r="2.4" />
    </>
  ),
};

/** True when `k` has its own glyph (the launch set + group tiles). Other types draw their GROUP's icon. */
export const hasIcon = (k: string) => k in ICONS;

export default function CategoryIcon({ k, size = 22 }: { k: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[k] ?? ICONS[GROUP_ICON[groupOf(k) ?? 'other']] ?? ICONS.other}
    </svg>
  );
}
