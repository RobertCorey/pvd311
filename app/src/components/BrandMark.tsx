/** SnapPVD mark: map pin whose hole is a camera aperture (spec §2). Inherits currentColor. */
export default function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 2a7 7 0 0 0-7 7c0 5 7 12 7 12s7-7 7-12a7 7 0 0 0-7-7z" fill="currentColor" />
      <circle cx="12" cy="9" r="3.2" fill="var(--surface, #fff)" />
      <circle cx="12" cy="9" r="1.4" fill="currentColor" />
      <path d="M9.2 6.6h1.4M13.4 6.6h1.4M9.2 11.4h1.4M13.4 11.4h1.4" stroke="var(--surface, #fff)" strokeWidth="0.9" strokeLinecap="round" />
    </svg>
  );
}
