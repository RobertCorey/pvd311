// Stroke icons on a 24px grid, one per category key (+ 'other').
const PATHS: Record<string, string> = {
  pothole: '<ellipse cx="12" cy="14" rx="7" ry="3.5"/><path d="M5 14c0-2 2-5 7-5s7 3 7 5"/><path d="M3 20h18"/>',
  street_light: '<path d="M9 3h6l2 6H7z"/><path d="M12 9v12"/><path d="M8 21h8"/><path d="M12 12l-3 3M12 12l3 3"/>',
  missed_trash: '<path d="M4 7h16"/><path d="M10 3h4l1 4H9z"/><path d="M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13"/><path d="M10 11v6M14 11v6"/>',
  illegal_dumping: '<path d="M3 20h18"/><path d="M5 20l2-8h10l2 8"/><path d="M9 12V8a3 3 0 016 0v4"/><path d="M4 4l16 16"/>',
  abandoned_vehicle: '<path d="M5 16l1.5-5h11L19 16"/><path d="M3 16h18v3H3z"/><circle cx="7" cy="19" r="1.5"/><circle cx="17" cy="19" r="1.5"/><path d="M7 11l1-3h8l1 3"/>',
  parking: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 17V7h4a3 3 0 010 6H9"/>',
  bins_carts: '<rect x="5" y="8" width="14" height="12" rx="1.5"/><path d="M4 8h16"/><path d="M9 5h6v3H9z"/><path d="M9 12v5M15 12v5"/>',
  animal_control: '<circle cx="7" cy="9" r="2"/><circle cx="17" cy="9" r="2"/><circle cx="10" cy="5" r="1.8"/><circle cx="14" cy="5" r="1.8"/><path d="M12 11c-3 0-5 2.5-5 5a3 3 0 003 3h4a3 3 0 003-3c0-2.5-2-5-5-5z"/>',
  noise: '<path d="M4 10v4h4l5 4V6L8 10z"/><path d="M16 9a4 4 0 010 6"/><path d="M18.5 6.5a8 8 0 010 11"/>',
  unshoveled_sidewalk: '<path d="M3 20h18"/><path d="M5 20l2-6h10l2 6"/><path d="M12 3v5M9.5 5.5L12 8l2.5-2.5"/>',
  missed_plowing: '<path d="M3 18h18"/><path d="M4 18l3-6h8l3 6"/><path d="M17 12h3l1 4"/><path d="M8 5l1 2M12 4v3M16 5l-1 2"/>',
  unsure: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 015 0c0 1.5-2.5 2-2.5 3.5"/><path d="M12 17h.01"/>',
  other: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
};

export default function CategoryIcon({ k, size = 22 }: { k: string; size?: number }) {
  const d = PATHS[k] ?? PATHS.other;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: d }} />
  );
}
