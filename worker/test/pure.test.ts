import { describe, it, expect } from 'vitest';
import { parseCityRow, mapCategory, cityItemId, parseCityDate } from '../src/cityfeed';
import { signAction, actionUrl, timingSafeEqualHex, HITL_LINK_TTL_MS } from '../src/email';
import { TERMINAL_PORTAL_STATUS } from '../src/contracts';

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
