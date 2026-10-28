import { describe, it, expect } from 'vitest';
import { followedCaseView, cityFollowEmail, caseUrl, eligibleFollowers, MAX_CITY_FOLLOWING, MAX_CASE_FOLLOWERS, CITY_GUID_RE } from '../src/cityfollow.js';
import { inferKind } from '../src/emaillog.js';
import type { UserDoc } from '../src/contracts.js';

const GUID = 'ab400112-05c8-f111-a3d0-001dd804b975';
const doc = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: GUID, caseType: 'Pothole', category: 'pothole', street: '12 Angell St', status: 'Assigned',
  createdAt: '2026-10-10T12:00:00.000Z', statusAt: '2026-10-11T12:00:00.000Z', firstSeenAt: '2026-10-10T12:30:00.000Z',
  statusSeen: { Submitted: '2026-10-10T12:30:00.000Z', Assigned: '2026-10-11T12:00:00.000Z' },
  lat: 41.8282, lng: -71.4005, detail: { resolution: null, resolutionDate: null }, followerUids: ['u1'], notifiedStatus: 'Assigned', ...o,
});

describe('followedCaseView', () => {
  it('an open case: the card facts, open=true, no closedAt, followedAt passed through, updatedAt = statusAt', () => {
    expect(followedCaseView(doc(), '2026-10-12T09:00:00.000Z')).toEqual({
      id: GUID, caseType: 'Pothole', category: 'pothole', street: '12 Angell St', status: 'Assigned', open: true,
      createdAt: '2026-10-10T12:00:00.000Z', closedAt: null, resolution: null, lat: 41.8282, lng: -71.4005,
      followedAt: '2026-10-12T09:00:00.000Z', updatedAt: '2026-10-11T12:00:00.000Z',
    });
  });
  it("closed with the city's resolution date: closedAt is that date, resolution trimmed", () => {
    const v = followedCaseView(doc({ status: 'Resolved', detail: { resolution: '  Pothole filled.\n', resolutionDate: '2026-10-13T15:00:00Z' }, statusSeen: { Submitted: '2026-10-10T12:30:00.000Z', Resolved: '2026-10-13T18:00:00.000Z' } }));
    expect(v).toMatchObject({ open: false, closedAt: '2026-10-13T15:00:00.000Z', resolution: 'Pothole filled.' });
  });
  it('closed without a resolution date: closedAt is the close we watched happen (statusSeen after firstSeenAt)', () => {
    const v = followedCaseView(doc({ status: 'Closed', detail: null, statusSeen: { Submitted: '2026-10-10T12:30:00.000Z', Closed: '2026-10-13T18:00:00.000Z' } }));
    expect(v).toMatchObject({ open: false, closedAt: '2026-10-13T18:00:00.000Z', resolution: null });
    // First seen already closed → no trustworthy close time.
    const seenClosed = followedCaseView(doc({ status: 'Resolved', detail: null, firstSeenAt: '2026-10-13T18:00:00.000Z', statusSeen: { Resolved: '2026-10-13T18:00:00.000Z' } }));
    expect(seenClosed).toMatchObject({ open: false, closedAt: null });
  });
  it('Cancelled and Merged are closed; missing fields become nulls / empty strings, never throw', () => {
    expect(followedCaseView(doc({ status: 'Cancelled' })).open).toBe(false);
    expect(followedCaseView(doc({ status: 'Merged' })).open).toBe(false);
    expect(followedCaseView({ id: GUID })).toEqual({
      id: GUID, caseType: '', category: 'unsure', street: '', status: '', open: true, createdAt: null, closedAt: null, resolution: null,
      lat: null, lng: null, followedAt: null, updatedAt: null,
    });
  });
});

describe('caseUrl + cityFollowEmail', () => {
  it('links the card on the map, framed by a map view (c/z, not a lat/lng point) only when the case is located', () => {
    expect(caseUrl('https://fixmypvd.org/', GUID, 41.8282, -71.4005)).toBe(`https://fixmypvd.org/street?case=${GUID}&c=41.8282,-71.4005&z=17`);
    expect(caseUrl('https://fixmypvd.org', GUID, null, null)).toBe(`https://fixmypvd.org/street?case=${GUID}`);
  });
  it('subject names the case and the new status; body says what the city did, quotes its note, dates the report, links the map', () => {
    const url = caseUrl('https://fixmypvd.org', GUID, 41.8282, -71.4005);
    const m = cityFollowEmail({ caseType: 'Street Light Out', street: '70 Example St', from: 'In Progress', to: 'Resolved', resolution: 'Bulb <replaced>', createdAt: '2026-10-10T12:00:00.000Z', url, base: 'https://fixmypvd.org' });
    expect(m.subject).toBe('City update: Street Light Out on 70 Example St — Resolved');
    expect(m.html).toContain('The city closed a request you follow: <b>Street Light Out</b> on 70 Example St.');
    expect(m.html).toContain('City status: <b>In Progress</b> → <b>Resolved</b>');
    expect(m.html).toContain('<blockquote');
    expect(m.html).toContain('Bulb &lt;replaced&gt;');
    expect(m.html).toContain('Reported Oct 10, 2026.');
    expect(m.html).toContain(`<a href="${url.replace(/&/g, '&amp;')}">See it on the map</a>`);
    expect(m.html).toContain('You follow this request on FixMyPVD. Change or stop these emails under <a href="https://fixmypvd.org/account/updates">Account → Updates</a>.');
    expect(m.html).toContain('not affiliated with the City of Providence');
    expect(m.html).not.toContain('your request');
  });
  it('without a note, a date, a known previous status or coordinates, the mail still reads', () => {
    const m = cityFollowEmail({ caseType: 'Pothole', street: '', from: null, to: 'Assigned', resolution: null, createdAt: null, url: caseUrl('https://fixmypvd.org', GUID, null, null), base: 'https://fixmypvd.org' });
    expect(m.subject).toBe('City update: Pothole — Assigned'); // a blank street is left out rather than "on "
    expect(m.html).toContain('The city assigned a request you follow: <b>Pothole</b>.');
    expect(m.html).toContain('City status: <b>Assigned</b>');
    expect(m.html).not.toContain('blockquote');
    expect(m.html).not.toContain('Reported');
    expect(m.html).toContain(`href="https://fixmypvd.org/street?case=${GUID}"`);
  });
  it('is classified city_follow by the email log', () => {
    expect(inferKind('City update: Pothole on 12 Angell St — Resolved', ['r@example.com'], { NOTIFY_EMAIL: 'rob@example.com' })).toBe('city_follow');
  });
});

describe('eligibleFollowers', () => {
  const user = (uid: string, o: Partial<UserDoc> = {}): UserDoc => ({
    uid, email: `${uid}@example.com`, emailVerified: true, displayName: null, provider: 'google', createdAt: '2026-10-01T00:00:00Z', lastSeenAt: '2026-10-01T00:00:00Z',
    prefs: { emailUpdates: true }, addresses: [], following: [], cityFollowing: [GUID], ...o,
  });
  it('keeps verified followers with email updates on; drops opted-out, unverified, address-less, missing and duplicate mailboxes', () => {
    const got = eligibleFollowers([
      user('on'), user('off', { prefs: { emailUpdates: false } }), user('unverified', { emailVerified: false }), user('noemail', { email: null }),
      user('legacy', { prefs: undefined as unknown as UserDoc['prefs'] }), null, undefined, user('dupe', { email: 'ON@example.com' }), user('junk', { email: 'not-an-address' }),
    ]);
    expect(got.map((u) => u.uid)).toEqual(['on', 'legacy']);
  });
  it('with a guid, an account whose own list no longer holds the case (trimmed off a full list) gets nothing', () => {
    expect(eligibleFollowers([user('a'), user('stale', { cityFollowing: [] }), user('old', { cityFollowing: undefined })], GUID).map((u) => u.uid)).toEqual(['a']);
    expect(eligibleFollowers([user('stale', { cityFollowing: [] })]).map((u) => u.uid)).toEqual(['stale']); // no guid → no list check
  });
  it('limits and the GUID shape are the API contract', () => {
    expect(MAX_CITY_FOLLOWING).toBe(100);
    expect(MAX_CASE_FOLLOWERS).toBe(200);
    expect(CITY_GUID_RE.test(GUID)).toBe(true);
    expect(CITY_GUID_RE.test(GUID.toUpperCase())).toBe(false);
    expect(CITY_GUID_RE.test('m3hPCS9K2-UfxNBB6Fscbg')).toBe(false); // one of our report ids
  });
});
