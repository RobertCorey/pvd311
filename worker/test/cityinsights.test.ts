import { describe, expect, it } from 'vitest';
import { buildInsights, classifyResolution, type CaseLike } from '../src/cityinsights.js';

describe('classifyResolution — the city\'s own words, as seen on the feed (2026-10-10…17)', () => {
  it.each([
    ['Branch picked up', 'work_done'],
    ['Pick up completed', 'work_done'],
    ['dumpster emptied', 'work_done'],
    ['citation issued. email sent. portal comment sent. JA PVD 311', 'enforcement'],
    ['Complaint (CODE-26-1449) has been received and logged into the system for review.', 'logged_elsewhere'],
    ['Complaint (CODE-26-1301) previously logged. Property actively being addressed.', 'logged_elsewhere'],
    ['Instructed to call PPD Non-Emergency Line.', 'referred'],
    ['Your service request has been submitted to the Providence Police Department.', 'referred'],
    ['Reported to HHS', 'referred'],
    ['Reported to Spin', 'referred'],
    ['This is a RI Dot owned and maintained intersection. DPW Traffic forwarded your service request to their signal maintenance division.', 'referred'],
    ['This address is located in North Providence. Constituent must reach out to their local Department of Inspections', 'referred'],
    ['Call was transferred', 'referred'],
    ['Information provided via email', 'info_only'],
    ['email sent, portal comment posted', 'info_only'],
    ['Inspected this address and did not see bins on the sidewalk.', 'no_action'],
    ['No information provided', 'no_action'],
    ['No issues with main line', 'no_action'],
    ['NAR', 'no_action'],
    ['', 'no_action'],
  ])('%s → %s', (msg, want) => expect(classifyResolution(msg)).toBe(want));
});

describe('buildInsights', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const base = { firstSeenAt: '2026-10-17T15:00:00Z' };
  const cases: CaseLike[] = [
    // watched close: first seen open, Resolved seen 2 days after creation
    { ...base, id: 'a', caseType: 'Tree Related Issue(s)', category: 'tree', status: 'Resolved', createdAt: '2026-10-17T10:00:00Z',
      statusSeen: { Submitted: '2026-10-17T15:00:00Z', Resolved: '2026-10-19T10:00:00Z' }, detail: { routedOn: '2026-10-17T11:00:00.0000000Z', resolution: 'Branch picked up' } },
    // first seen already resolved: no trustworthy close time
    { ...base, id: 'b', caseType: 'Tree Related Issue(s)', category: 'tree', status: 'Resolved', createdAt: '2026-10-12T10:00:00Z',
      statusSeen: { Resolved: '2026-10-17T15:00:00Z' }, detail: { routedOn: '2026-10-12T13:00:00.0000000Z', resolution: 'Pick up completed' } },
    { ...base, id: 'c', caseType: 'Missed Trash Day Pick-up Issue', category: 'missed_trash', status: 'Assigned', createdAt: '2026-10-11T10:00:00Z', detail: { routedOn: '2026-10-11T10:30:00Z' } },
    { ...base, id: 'd', caseType: 'Parking Issues to Report', category: 'parking', status: 'Resolved', createdAt: '2026-10-18T10:00:00Z', detail: { resolution: 'Instructed to call PPD Non-Emergency Line.' } },
    { ...base, id: 'e', caseType: 'Pothole Report', category: 'pothole', status: 'Cancelled', createdAt: '2026-10-19T10:00:00Z' },
    { ...base, id: 'old', caseType: 'Pothole Report', category: 'pothole', status: 'Assigned', createdAt: '2026-08-01T10:00:00Z' },
  ];
  const ins = buildInsights(cases, { days: 30, now });

  it('counts the window only, with outcomes, routing and watched closes', () => {
    expect(ins.total.n).toBe(5);
    expect(ins.total.outcomes).toMatchObject({ work_done: 2, referred: 1, cancelled: 1, open: 1 });
    expect(ins.total.openOver7d).toBe(1);
    const trees = ins.groups.find((g) => g.group === 'trees')!;
    expect(trees).toMatchObject({ n: 2, routed: 2, medRouteHours: 2, closed: 2, closeSample: 1, medCloseDays: 2 });
    expect(trees.types[0].examples.map((e) => e.text)).toEqual(['Branch picked up', 'Pick up completed']);
  });
  it('groups by the picker group of the mapped category', () => {
    expect(ins.groups.map((g) => g.group).sort()).toEqual(['streets', 'traffic', 'trash', 'trees'].sort());
  });
});
