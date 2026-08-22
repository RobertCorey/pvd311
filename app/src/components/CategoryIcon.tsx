import type { ReactNode } from 'react';

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
      {ICONS[k] ?? ICONS.other}
    </svg>
  );
}
