import { describe, expect, it } from 'vitest';
import { weekSummary } from '../src/week.js';
import { fetchWeather, skyOf, weekCases, week311Email, writeUpInput } from '../src/week311.js';

// Sunday 2026-10-25 12:00 UTC: the week in progress is Mon Oct 19 → now.
const NOW = Date.parse('2026-10-25T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const COLLEGE_HILL = { lat: 41.8262, lng: -71.4032 };
const row = (id: string, o: Record<string, unknown> = {}) => ({
  id, caseType: 'Pothole', category: 'pothole', street: '10 Angell St', status: 'Assigned', createdAt: daysAgo(3), firstSeenAt: daysAgo(3), ...COLLEGE_HILL, ...o,
});

describe('week311', () => {
  const rows = [
    row('a', { caseType: 'Dead Animal', detail: { resolution: 'Removed.', answers: { t: 'Raccoon', p: 'ABC123' }, labels: { t: 'Type of Animal', p: 'License Plate' }, kinds: { t: 'choice', p: 'text' } } }),
    row('b'), row('old', { createdAt: daysAgo(12), firstSeenAt: daysAgo(12) }), row('d', { status: 'Draft' }),
  ];
  const s = weekSummary(rows, { now: NOW });

  it('weekCases: this week only, no drafts, fixed-choice answers only (no plates)', () => {
    const cs = weekCases(rows, s);
    expect(cs.map((c) => c.id).sort()).toEqual(['a', 'b']);
    const a = cs.find((c) => c.id === 'a')!;
    expect(a.answers).toEqual(['Type of Animal: Raccoon']);
    expect(a.hood).toBe('College Hill');
    expect(writeUpInput(s, null, cs)).not.toContain('ABC123');
  });

  it('mail: overview and case of the week when the write-up names a case from the list; escapes', () => {
    const cases = weekCases(rows, s);
    const m = week311Email(s, { base: 'https://fixmypvd.org/', weather: [{ date: '2026-10-20', hiF: 61, loF: 44, rainIn: 0.5, snowIn: 0, windMph: 20, sky: 'rain' }], cases,
      ai: { overview: 'Potholes <led>.', pick: { id: 'a', headline: 'A raccoon', blurb: 'One raccoon.' } } });
    expect(m.subject).toMatch(/^This week in 311 \(Oct 19 – Oct 25\): 2 requests$/);
    expect(m.html).toContain('Potholes &lt;led&gt;.');
    expect(m.html).toContain('Case of the week');
    expect(m.html).toContain('The city: “Removed.”');
    expect(m.html).toContain('rain, 0.5 in<');
    expect(m.html).toContain('https://fixmypvd.org/week?until=2026-10-25');
  });

  it('mail without the write-up or weather still has the numbers', () => {
    const m = week311Email(s, { base: 'https://fixmypvd.org', weather: null, cases: [], ai: null });
    expect(m.html).not.toContain('Case of the week');
    expect(m.html).not.toContain('Weather');
    expect(m.html).toContain('<b>2</b> requests');
  });

  it('weather: parses Open-Meteo daily, inches as given; null on failure', async () => {
    const ok = (async () => new Response(JSON.stringify({ daily: { time: ['2026-10-20'], temperature_2m_max: [60.6], temperature_2m_min: [44.2], rain_sum: [0.404], snowfall_sum: [1.04], wind_speed_10m_max: [12], weather_code: [63] } }))) as unknown as typeof fetch;
    expect(await fetchWeather('2026-10-20', '2026-10-20', ok)).toEqual([{ date: '2026-10-20', hiF: 61, loF: 44, rainIn: 0.4, snowIn: 1, windMph: 12, sky: 'rain' }]);
    const bad = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
    expect(await fetchWeather('2026-10-20', '2026-10-20', bad)).toBeNull();
    expect(skyOf(0)).toBe('clear'); expect(skyOf(75)).toBe('snow');
  });
});
