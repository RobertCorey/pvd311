import { test, expect } from '@playwright/test';
import { weekPostMarkdown, weekPostRange, tEn } from '../src/lib/weekPost';
import type { WeekSummary } from '../src/api/week';
import { DATED, QUIET, WEEK } from './week-mocks';

// lib/weekPost.ts — the "Copy as post" Markdown for /week, built from the same body the page renders. Pure module, no
// browser: the exact string for the fixture week, then every line that is left out or reworded for an edge.

const BASE = 'https://fixmypvd.org';
const SUMMARY: WeekSummary = { ...WEEK, days: 7 };
const post = (over: Partial<WeekSummary> = {}, base = BASE) => weekPostMarkdown({ ...SUMMARY, ...over }, { base });
const lines = (md: string) => md.split('\n\n');

test('the fixture week, exactly: title with the range, the numbers line, the three lists, the closes, the link and the source', () => {
  expect(post()).toBe([
    '**This week in Providence (Oct 18 – Oct 25)**',
    '312 requests to 311 (+22 vs last week), 114 closed, median 3.5 days to close.',
    'Most reported: Pothole (61), Street Light Out (44), Missed Trash Pickup (39).',
    'Busiest: Elmhurst (48), West End (41), Downtown (36).',
    // 40 / 114 = 35.1, 30 / 114 = 26.3, 20 / 114 = 17.5 → 18; six outcomes have a count, so the three named end in "…".
    'What closing meant: 35% work done, 26% referred elsewhere, 18% logged in another system…',
    '- Street Light Out, 22 Thayer St (College Hill): "Bulb replaced."\n- Pothole, 10 Angell St (College Hill): "Filled with cold patch; permanent repair scheduled."\n- Graffiti: "Referred to Parks."',
    "Full week, map and the city's own notes: https://fixmypvd.org/week?until=2026-10-25",
    "From Providence 311's public request list. Not affiliated with the city.",
  ].join('\n\n'));
});

test('a dated week is titled by its seven calendar days and links to its own date', () => {
  const md = weekPostMarkdown({ ...DATED, days: 7 }, { base: BASE });
  expect(lines(md)[0]).toBe('**This week in Providence (Oct 12 – Oct 18)**');
  expect(md).toContain('https://fixmypvd.org/week?until=2026-10-18');
  // The current week reads its range off since/until (Providence days); without them it falls back to untilDate − 6.
  expect(weekPostRange(SUMMARY)).toBe('Oct 18 – Oct 25');
  expect(weekPostRange({ ...SUMMARY, since: '', until: '' })).toBe('Oct 19 – Oct 25');
  expect(weekPostRange({ ...SUMMARY, since: '', until: '', untilDate: '' })).toBe('');
  expect(lines(post({ since: '', until: '', untilDate: '' }))[0]).toBe('**This week in Providence**');
  expect(post({ untilDate: '' })).toContain("notes: https://fixmypvd.org/week\n\n");
});

test('the delta: + for more, − (U+2212) for fewer, "same" for equal; thousands separators', () => {
  expect(lines(post({ prev: { total: 324, closed: 130 } }))[1]).toBe('312 requests to 311 (−12 vs last week), 114 closed, median 3.5 days to close.');
  expect(lines(post({ prev: { total: 312, closed: 130 } }))[1]).toBe('312 requests to 311 (same as last week), 114 closed, median 3.5 days to close.');
  expect(lines(post({ total: 1234, prev: { total: 234, closed: 0 }, closed: 1000 }))[1]).toBe('1,234 requests to 311 (+1,000 vs last week), 1,000 closed, median 3.5 days to close.');
});

test('singular forms: 1 request, median 1 day (after rounding to a decimal)', () => {
  expect(lines(post({ total: 1, prev: { total: 0, closed: 0 }, closed: 1, medianCloseDays: 1 }))[1]).toBe('1 request to 311 (+1 vs last week), 1 closed, median 1 day to close.');
  expect(lines(post({ medianCloseDays: 1.04 }))[1]).toContain('median 1 day to close');
  expect(lines(post({ medianCloseDays: 1.05 }))[1]).toContain('median 1.1 days to close');
  expect(lines(post({ medianCloseDays: 0.4 }))[1]).toContain('median 0.4 days to close');
});

test('no median → the clause is left out', () => {
  expect(lines(post({ medianCloseDays: null }))[1]).toBe('312 requests to 311 (+22 vs last week), 114 closed.');
});

test('no notable closes → no list: the outcomes line is followed by the link line', () => {
  const l = lines(post({ notable: [] }));
  expect(l).toHaveLength(7);
  expect(l[4]).toMatch(/^What closing meant:/);
  expect(l[5]).toMatch(/^Full week, map/);
  // More than three closes → only the first three (the Worker sends them newest first).
  const many = SUMMARY.notable.concat([{ ...SUMMARY.notable[0], id: 'n4', street: '1 Extra St' }]);
  expect(lines(post({ notable: many }))[5].split('\n')).toHaveLength(3);
});

test('closes: street and neighborhood only when given, the note on one line, no quote when the note is blank', () => {
  const n = SUMMARY.notable[0];
  const line = (over: Partial<typeof n>) => lines(post({ notable: [{ ...n, ...over }] }))[5];
  expect(line({})).toBe('- Street Light Out, 22 Thayer St (College Hill): "Bulb replaced."');
  expect(line({ neighborhood: null })).toBe('- Street Light Out, 22 Thayer St: "Bulb replaced."');
  expect(line({ street: '' })).toBe('- Street Light Out (College Hill): "Bulb replaced."');
  expect(line({ resolution: 'Crew went out.\n\n  Bulb  replaced. ' })).toBe('- Street Light Out, 22 Thayer St (College Hill): "Crew went out. Bulb replaced."');
  expect(line({ resolution: '' })).toBe('- Street Light Out, 22 Thayer St (College Hill)');
  // A blank city type falls back to the group's name.
  expect(line({ caseType: '', category: 'street_light' })).toBe('- Lights, 22 Thayer St (College Hill): "Bulb replaced."');
});

test('outcomes: ranked by share, the dictionary order breaks ties, "." when three or fewer have a count, no line when none closed', () => {
  const zero = { work_done: 0, enforcement: 0, referred: 0, logged_elsewhere: 0, info_only: 0, no_action: 0, cancelled: 0 };
  expect(lines(post({ outcomes: { ...zero, no_action: 42, referred: 16, work_done: 12 } }))[4]).toBe('What closing meant: 60% nothing found, 23% referred elsewhere, 17% work done.');
  expect(lines(post({ outcomes: { ...zero, work_done: 5, referred: 5 } }))[4]).toBe('What closing meant: 50% work done, 50% referred elsewhere.');
  expect(lines(post({ outcomes: { ...zero, cancelled: 3 } }))[4]).toBe('What closing meant: 100% cancelled or merged.');
  const none = lines(post({ outcomes: zero }));
  expect(none.some((l) => l.startsWith('What closing meant'))).toBe(false);
  expect(none).toHaveLength(7);
});

test('lists: at most three types and three neighborhoods; a blank city type reads as its group; empty lists are left out', () => {
  expect(lines(post({ topTypes: SUMMARY.topTypes.slice(0, 2) }))[2]).toBe('Most reported: Pothole (61), Street Light Out (44).');
  expect(lines(post({ topTypes: [{ caseType: '', category: 'pothole', n: 7, prevN: 1 }] }))[2]).toBe('Most reported: Streets (7).');
  expect(lines(post({ neighborhoods: SUMMARY.neighborhoods.slice(0, 1) }))[3]).toBe('Busiest: Elmhurst (48).');
  const bare = lines(post({ topTypes: [], neighborhoods: [] }));
  expect(bare[2]).toMatch(/^What closing meant:/);
  expect(bare).toHaveLength(6);
});

test('a quiet week still makes a post: the numbers line and the link, nothing else in between', () => {
  const md = weekPostMarkdown({ ...QUIET, days: 7 }, { base: BASE });
  expect(lines(md)).toEqual([
    '**This week in Providence (Oct 18 – Oct 25)**',
    '0 requests to 311 (same as last week), 0 closed.',
    "Full week, map and the city's own notes: https://fixmypvd.org/week?until=2026-10-25",
    "From Providence 311's public request list. Not affiliated with the city.",
  ]);
});

test('labels come from the English dictionary whatever the app language; a caller may pass its own t', () => {
  expect(tEn('week.outcome.no_action')).toBe('Nothing found');
  expect(tEn('street.g.lights')).toBe('Lights');
  expect(tEn('week.delta.up', { n: 3 })).toBe('3 more than last week');
  expect(tEn('no.such.key')).toBe('no.such.key');
  const md = weekPostMarkdown(SUMMARY, { base: BASE, t: (k) => `<${k}>` });
  expect(lines(md)[4]).toBe('What closing meant: 35% <week.outcome.work_done>, 26% <week.outcome.referred>, 18% <week.outcome.logged_elsewhere>…');
});
