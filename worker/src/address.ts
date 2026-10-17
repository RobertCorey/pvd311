/**
 * address.ts — pure helpers for what address/description the wizard sends the city.
 * No Playwright import so unit tests (test/pure.test.ts) can load it without the cloudflare: scheme.
 */
import type { ReportDoc } from './contracts.js';


/** "201 India St", "12A Hope St", "1-3 Main St" → true; "India St" → false. */
export function hasHouseNumber(street: string | null | undefined): boolean {
  return /^\s*\d+[A-Za-z]?(?:-\d+)?\s+\S/.test(street ?? '');
}

/** Leading house number, lowercased ("217 Medway" → "217", "12A Hope St" → "12a"); null when there is none. */
function houseNumber(street: string | null | undefined): string | null {
  const m = /^\s*(\d+[A-Za-z]?(?:-\d+)?)\s+\S/.exec(street ?? '');
  return m ? m[1].toLowerCase() : null;
}

/**
 * Which address goes into Step 2. The app pre-fills the address from the same ArcGIS reverse geocode, so
 * a typed house number that differs from the pin's is the reporter correcting it — and ArcGIS's number is
 * often interpolated from a block range: PVD2026-90139 went to the city as "258 Medway St" (range 232-272)
 * when Rob typed "217 Medway". The typed address goes first whenever it carries a house number the pin
 * lacks or disagrees with; the city's autocomplete resolves it, and the pin is the fallback.
 */
export function chooseStep2Source(typed: string, pinStreet: string | null): 'pin' | 'typed-then-pin' | 'typed' {
  if (pinStreet == null) return 'typed';
  const t = houseNumber(typed);
  if (!t || t === houseNumber(pinStreet)) return 'pin';
  return 'typed-then-pin';
}

/**
 * A hello to the city staff who read every case we file (Rob, 2026-10-16: "we want to be friends … let me
 * know if there's anything I can do for you"). The contact is rob@, not the relay address: city mail that
 * names a case id at cases@ is forwarded to that case's reporter (relay.ts), and this is a note for us.
 */
export const CITY_NOTE =
  'FixMyPVD is a free app run by a Providence resident that files reports into 311 on residents\' behalf; ' +
  'it is not part of the City. We want to make your job easier. If there is anything we should do ' +
  'differently, or stop doing, please email rob@fixmypvd.org.';

/**
 * Step 3 description: the reporter's words, the address they typed (the portal's Step 2 record may be
 * coarser than what they wrote — see chooseStep2Source), the exact pin, our ref tag, and the note to staff.
 */
export function buildDescription(
  report: Pick<ReportDoc, 'id' | 'description' | 'address' | 'lat' | 'lng'>,
  appName: string,
): string {
  const parts: string[] = [];
  if (report.description?.trim()) parts.push(report.description.trim());
  if (report.address?.trim()) parts.push(`Address given by reporter: ${report.address.trim()}`);
  if (report.lat && report.lng) {
    parts.push(`Exact location: https://maps.google.com/?q=${report.lat.toFixed(6)},${report.lng.toFixed(6)}`);
  }
  parts.push(`[Submitted via ${appName} — ref:${report.id}]`);
  parts.push(CITY_NOTE);
  return parts.join('\n\n');
}
