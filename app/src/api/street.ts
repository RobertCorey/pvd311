// "My street": city cases near a point, from the Worker's public-feed record (worker/src/street.ts).
import { apiFetch, parseError, withTimeout } from './client';

export interface StreetCase {
  id: string; caseType: string; category: string; street: string; status: string; open: boolean;
  createdAt: string | null; closedAt: string | null; resolution: string | null;
  lat: number; lng: number; distanceM: number;
}
export interface StreetResponse { items: StreetCase[]; radiusM: number; days: number; at: string }
export type CityCase = Omit<StreetCase, 'lat' | 'lng' | 'distanceM'>;
export interface CityOverview { days: number; total: number; open: number; closed: number; located: number; topTypes: { caseType: string; category: string; n: number }[]; latest: CityCase[]; at: string }

export async function getStreetCity(days = 7): Promise<CityOverview> {
  const t = withTimeout(15_000);
  try {
    const resp = await apiFetch(`/api/street/city?days=${days}`, { signal: t.signal });
    if (!resp.ok) throw await parseError(resp);
    return (await resp.json()) as CityOverview;
  } finally { t.done(); }
}

export async function getStreet(lat: number, lng: number, o: { radiusM?: number; days?: number } = {}): Promise<StreetResponse> {
  const t = withTimeout(15_000);
  try {
    const p = new URLSearchParams({ lat: lat.toFixed(5), lng: lng.toFixed(5) });
    if (o.radiusM) p.set('radiusM', String(o.radiusM));
    if (o.days) p.set('days', String(o.days));
    const resp = await apiFetch(`/api/street?${p}`, { signal: t.signal });
    if (!resp.ok) throw await parseError(resp);
    return (await resp.json()) as StreetResponse;
  } finally { t.done(); }
}
