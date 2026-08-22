/** Providence skyline signature (footer): triple-decker · Superman Building · State House dome · the pedestrian
 *  bridge over the river with WaterFire braziers. Ink line art, ember flames. Decorative only. */
export default function Skyline({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 600 90" className={className} aria-hidden="true" fill="none" stroke="var(--ink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {/* ground / waterline */}
      <path d="M0 78 H250 M350 78 H600" />
      {/* triple-decker (left) */}
      <path d="M28 78 V40 L44 30 L60 40 V78" />
      <path d="M28 52 H60 M28 64 H60" />
      <path d="M38 46 h8 M38 58 h8 M38 70 h8" />
      {/* Industrial Trust "Superman" building: stepped tower + lantern */}
      <path d="M110 78 V46 H120 V34 H128 V20 H140 V10 H148 V20 H160 V34 H168 V46 H178 V78" />
      <path d="M144 4 v6 M136 28 h16 M130 40 h28 M124 52 h40 M124 64 h40" />
      {/* mid-rise */}
      <path d="M196 78 V50 H230 V78" />
      <path d="M204 58 h6 M216 58 h6 M204 68 h6 M216 68 h6" />
      {/* the pedestrian bridge over the river: deck + gentle arch + piers */}
      <path d="M250 78 Q300 62 350 78" />
      <path d="M250 78 V72 Q300 56 350 72 V78" />
      <path d="M262 70 v-6 M300 63 v-6 M338 70 v-6" />
      {/* WaterFire braziers on the river (ember) */}
      <g fill="var(--ember)" stroke="none">
        <path d="M280 86 c-4 -5 -1 -8 2 -11 c1 4 5 4 4 9 c-1 3 -4 4 -6 2z" />
        <path d="M300 88 c-4 -5 -1 -8 2 -11 c1 4 5 4 4 9 c-1 3 -4 4 -6 2z" />
        <path d="M320 86 c-4 -5 -1 -8 2 -11 c1 4 5 4 4 9 c-1 3 -4 4 -6 2z" />
      </g>
      <path d="M276 89 h10 M296 89 h10 M316 89 h10" strokeWidth="2" />
      {/* State House: colonnade + dome + lantern (no seal, no figure) */}
      <path d="M380 78 V56 H460 V78" />
      <path d="M390 78 V60 M402 78 V60 M414 78 V60 M426 78 V60 M438 78 V60 M450 78 V60" />
      <path d="M396 56 V48 H444 V56" />
      <path d="M398 48 Q420 18 442 48" />
      <path d="M420 26 V16 M416 16 h8 M420 10 v6" />
      {/* east side: a church steeple + triple-decker */}
      <path d="M492 78 V52 L500 34 L508 52 V78 M500 34 V26" />
      <path d="M532 78 V44 L548 34 L564 44 V78 M532 56 H564 M532 67 H564" />
    </svg>
  );
}
