/** FixMyPVD mark (docs/design-direction.md): harbor-ink map pin with an "×" — X marks the spot to fix —
 *  over an ember plate printed slightly off-register (the riso tell). Pin inherits currentColor. */
export default function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="13.6" cy="11" r="7.2" fill="var(--ember, #F4652A)" />
      <path d="M12 1.5a7.5 7.5 0 0 0-7.5 7.5c0 5.6 7.5 13 7.5 13s7.5-7.4 7.5-13A7.5 7.5 0 0 0 12 1.5z" fill="currentColor" />
      <path d="M9.3 6.3l5.4 5.4M14.7 6.3l-5.4 5.4" stroke="var(--bg, #F7F1E6)" strokeWidth="2.3" strokeLinecap="round" />
    </svg>
  );
}
