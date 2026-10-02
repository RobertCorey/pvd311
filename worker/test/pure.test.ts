import { describe, it, expect } from 'vitest';
import { parseCityRow, mapCategory, cityItemId, parseCityDate } from '../src/cityfeed';
import { signAction, actionUrl, timingSafeEqualHex, HITL_LINK_TTL_MS } from '../src/email';
import { TERMINAL_PORTAL_STATUS } from '../src/contracts';
import { hasHouseNumber, chooseStep2Source, buildDescription } from '../src/address';

describe('cityfeed parsing', () => {
  const headers = ['Case Type', 'Street', 'Status Reason', 'Created On'];
  it('parses a grid row by header', () => {
    const r = parseCityRow(headers, ['Pothole Report', '25 Dorrance St', 'Assigned', '8/22/2026 1:23 PM']);
    expect(r).toMatchObject({ caseTypeName: 'Pothole Report', street: '25 Dorrance St', status: 'Assigned' });
  });
  it('drops rows without a street', () => {
    expect(parseCityRow(headers, ['Pothole Report', '', 'Draft', '8/22/2026 1:23 PM'])).toBeNull();
  });
  it('maps city case types to our categories (incl. abbreviated analytics labels)', () => {
    expect(mapCategory('Pothole Report')).toBe('pothole');
    expect(mapCategory('Missed Trash Day Pick-up Issue')).toBe('missed_trash');
    expect(mapCategory('Trash or Recycling Bins/Carts')).toBe('bins_carts');
    expect(mapCategory('Snow Plowing/Salting/Sanding')).toBe('missed_plowing');
    expect(mapCategory('Completely Unknown Thing')).toBe('unsure');
  });
  it('ids are stable and dates parse', () => {
    const it1 = { caseTypeName: 'Pothole Report', street: '25 Dorrance St', createdOn: '8/22/2026 1:23 PM' };
    expect(cityItemId(it1)).toBe(cityItemId({ ...it1 }));
    expect(parseCityDate('8/22/2026 1:23 PM')).toMatch(/^2026-08-22T/);
    expect(parseCityDate('garbage')).toBeNull();
  });
});

describe('signed HITL links', () => {
  it('signs deterministically and verifies constant-time', async () => {
    const a = await signAction('secret', 'approve', 'abc', 2000000000);
    const b = await signAction('secret', 'approve', 'abc', 2000000000);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await signAction('secret', 'reject', 'abc', 2000000000)).not.toBe(a);
    expect(await signAction('secret', 'approve', 'abc', 2000000001)).not.toBe(a); // expiry is part of the signed payload
    expect(await signAction('other', 'approve', 'abc', 2000000000)).not.toBe(a);
    expect(timingSafeEqualHex(a, b)).toBe(true);
    expect(timingSafeEqualHex(a, a.slice(0, -1) + (a.endsWith('0') ? '1' : '0'))).toBe(false);
    const now = 2000000000 * 1000 - HITL_LINK_TTL_MS;
    expect(await actionUrl('https://api.fixmypvd.org', 'secret', 'approve', 'abc', now)).toBe(`https://api.fixmypvd.org/hitl/approve/abc/2000000000/${a}`);
    // No "=" anywhere: a hex sig after "=" forms "=XX" pairs that quoted-printable mis-decodes corrupt.
    expect(await actionUrl('https://api.fixmypvd.org/', 'secret', 'reject', 'x-y_Z')).not.toMatch(/=/);
  });
});

describe('terminal portal statuses', () => {
  it('treats Resolved/Closed/Completed/Cancelled as terminal, not Assigned/In Progress/Submitted', () => {
    for (const t of ['Resolved', 'Closed', 'Completed', 'Cancelled', 'Canceled', 'Closed - Duplicate']) expect(TERMINAL_PORTAL_STATUS.test(t)).toBe(true);
    for (const t of ['Assigned', 'In Progress', 'Submitted', 'Draft', 'Open']) expect(TERMINAL_PORTAL_STATUS.test(t)).toBe(false);
  });
});

describe('Step 2 address choice (PVD2026-89374 went to the city as "India St" when Rob typed "201 India street")', () => {
  it('hasHouseNumber', () => {
    expect(hasHouseNumber('201 India St')).toBe(true);
    expect(hasHouseNumber('12A Hope St')).toBe(true);
    expect(hasHouseNumber('1-3 Main St')).toBe(true);
    expect(hasHouseNumber('India St')).toBe(false);
    expect(hasHouseNumber('')).toBe(false);
    expect(hasHouseNumber(null)).toBe(false);
  });
  it('pin wins when its reverse geocode has a house number, or the reporter typed none', () => {
    expect(chooseStep2Source('201 India street', '201 India St')).toBe('pin');
    expect(chooseStep2Source('India St near the park', 'India St')).toBe('pin');
  });
  it('typed address first (pin as fallback) when ArcGIS returned only a street name', () => {
    expect(chooseStep2Source('201 India street', 'India St')).toBe('typed-then-pin');
  });
  it('no pin → typed', () => {
    expect(chooseStep2Source('201 India street', null)).toBe('typed');
  });
  it('description always carries the typed address, the pin link, and the ref tag', () => {
    const d = buildDescription({ id: 'abc', description: null, address: '201 India street', lat: 41.81786944, lng: -71.39075833 } as any, 'FixMyPVD');
    expect(d).toBe('Address given by reporter: 201 India street\n\nExact location: https://maps.google.com/?q=41.817869,-71.390758\n\n[Submitted via FixMyPVD — ref:abc]');
    const e = buildDescription({ id: 'abc', description: '  Wire down across the sidewalk. ', address: '', lat: null, lng: null } as any, 'FixMyPVD');
    expect(e).toBe('Wire down across the sidewalk.\n\n[Submitted via FixMyPVD — ref:abc]');
  });
});

import { appendStatusHistory, STATUS_HISTORY_CAP } from '../src/statushistory';
describe('appendStatusHistory', () => {
  it('appends each change oldest-first, skips a repeat of the latest, caps the list', () => {
    const t1 = new Date('2026-09-29T13:02:59Z'); const t2 = new Date('2026-09-29T15:31:30Z');
    let h = appendStatusHistory(null, 'Submitted', t1);
    expect(h).toEqual([{ status: 'Submitted', at: t1.toISOString() }]);
    h = appendStatusHistory(h, 'Submitted', t2); // watcher saw the same status again — not a change
    expect(h).toHaveLength(1);
    h = appendStatusHistory(h, 'Assigned', t2);
    expect(h.map((x) => x.status)).toEqual(['Submitted', 'Assigned']);
    for (let i = 0; i < STATUS_HISTORY_CAP + 5; i++) h = appendStatusHistory(h, `S${i}`, t2);
    expect(h).toHaveLength(STATUS_HISTORY_CAP);
    expect(h[h.length - 1].status).toBe(`S${STATUS_HISTORY_CAP + 4}`);
  });
});
