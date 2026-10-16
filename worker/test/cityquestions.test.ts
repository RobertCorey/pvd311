/**
 * cityquestions.test.ts — phase 1 of docs/city-questions.md: the committed seed, the per-filing audit (flags, answer
 * counts, idempotency, never-throw), the admin view ranking, the digest lines and the admin route.
 */
import { describe, it, expect, vi } from 'vitest';
import { CATEGORIES } from '../../shared/categories.js';
import {
  SEED, auditFiling, auditCityQuestions, appOptions, optionAccepts, buildAdminView, questionsDigest,
  type CityQuestionsDoc, type SeedQuestion,
} from '../src/cityquestions';
import { handleAdmin } from '../src/adminapi';
import type { Store } from '../src/contracts';
import type { PortalControl } from '../src/scout';

const AT1 = '2026-10-16T12:00:00.000Z';
const AT2 = '2026-10-17T12:00:00.000Z';
const ctl = (id: string, label: string, options?: string[], o: Partial<PortalControl> = {}): PortalControl =>
  ({ id, domId: id, label, tag: options ? 'select' : 'input', type: options ? 'select-one' : 'text', required: false, visible: true, ...(options ? { options } : {}), ...o });
/** The live controls a filing would see if the city matched the seed exactly (toggles are never in a dump). */
const liveFromSeed = (cat: string): PortalControl[] => (SEED.categories[cat] ?? []).filter((q) => q.type !== 'toggle').map((q) =>
  q.type === 'radio' ? { id: q.id, label: q.cityLabel, tag: 'input', type: 'radio', name: `x$${q.id}`, required: false, visible: true, options: q.cityOptions }
  : q.type === 'select' ? ctl(q.id, q.cityLabel, q.cityOptions)
  : ctl(q.id, q.cityLabel, undefined, { tag: q.type === 'textarea' ? 'textarea' : 'input', type: q.type === 'textarea' ? 'textarea' : 'text' }));
/** Hidden controls ride along in every dump — they must never count or flag. */
const hiddenNoise = [ctl('cop_servicetype', 'Service Type', ['Noise', 'Trash'], { visible: false }), ctl('q', 'Search', undefined, { visible: true }), ctl('filter-{guid}', 'Search Filter', ['All'], { visible: true })];

describe('seed (shared/city-questions.seed.json)', () => {
  const switchGuids = new Set(Object.keys(SEED.caseTypes));
  it('covers exactly the categories whose case-type GUID appears in the city switch', () => {
    const expected = Object.entries(CATEGORIES).filter(([, c]) => switchGuids.has(c.portalCaseTypeGuid.toLowerCase())).map(([k]) => k).sort();
    expect(Object.keys(SEED.categories).sort()).toEqual(expected);
    expect(expected.length).toBe(27);
    // and the per-case-type back-references agree
    const back = Object.values(SEED.caseTypes).flatMap((t) => t.categories).sort();
    expect(back).toEqual(expected);
  });
  it('has the 30 case types of the 2026-10-16 switch and no disclaimer or site-search control as a question', () => {
    expect(switchGuids.size).toBe(30);
    const ids = Object.values(SEED.categories).flat().map((q) => q.id);
    expect(ids.some((id) => /disclaimer$/.test(id) || id === 'q' || id.startsWith('filter-'))).toBe(false);
  });
  it('every app-answered control is in the seed, and every option the app can send is a city option', () => {
    for (const [cat, mapped] of Object.entries(Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, appOptions(k)])))) {
      for (const [id, opts] of Object.entries(mapped)) {
        const q = SEED.categories[cat]?.find((x) => x.id === id);
        expect(q, `${cat}.${id} in seed`).toBeTruthy();
        if (!q!.cityOptions.length) continue;
        for (const o of opts) expect(q!.cityOptions.some((lo) => optionAccepts(q!.type, lo, o, q!.cityLabel)), `${cat}.${id} accepts "${o}"`).toBe(true);
      }
    }
  });
  it('records the missed-trash script error (its case shows nothing) as a category note', () => {
    expect(SEED.categories.missed_trash).toEqual([]);
    expect(SEED.categoryNotes.missed_trash).toMatch(/elements\.elements\.cop_servicerequestnumber/);
  });
});

describe('auditFiling', () => {
  it('a filing that matches the seed: no flags; app / ai / blank counted per question; toggles count blank', () => {
    // graffiti_private: 2 selects + 4 toggles in the seed. Scout sets surface type only.
    const out = auditFiling({ category: 'graffiti_private', reportId: 'r1', at: AT1, prev: null, controls: [...liveFromSeed('graffiti_private'), ...hiddenNoise], scouted: { cop_surfacetype: 'Brick' } });
    expect(out.flags).toEqual([]);
    const by = Object.fromEntries(out.doc.questions.map((q) => [q.id, q]));
    expect(by.cop_surfacetype.counts).toEqual({ app: 0, ai: 1, blank: 0 });
    expect(by.cop_typeofproperty.counts).toEqual({ app: 0, ai: 0, blank: 1 });
    expect(by.cop_presscharges.counts).toEqual({ app: 0, ai: 0, blank: 1 }); // toggle
    expect(by.cop_presscharges.lastSeenLive).toBeNull();                     // the dump never sees toggles
    expect(by.cop_surfacetype.lastSeenLive).toBe(AT1);
    expect(out.doc.questions.map((q) => q.id)).not.toContain('cop_servicetype'); // hidden control ignored
    expect(out.doc.questions.map((q) => q.id)).not.toContain('q');
    expect(out.doc).toMatchObject({ category: 'graffiti_private', filings: 1, lastFiledAt: AT1, auditedIds: ['r1'] });
  });

  it('app-mapped controls count as app; scout values the scout was unsure of (leftBlank) count blank', () => {
    const app = auditFiling({ category: 'pothole', reportId: 'r1', at: AT1, prev: null, controls: liveFromSeed('pothole') });
    expect(app.doc.questions[0].counts).toEqual({ app: 1, ai: 0, blank: 0 });
    expect(app.answered).toEqual({ cop_size: 'app' });
    const unsure = auditFiling({ category: 'noise', reportId: 'r2', at: AT1, prev: null, controls: liveFromSeed('noise'), scouted: null, leftBlank: ['Where is the noise from'] });
    expect(unsure.answered).toEqual({ cop_whereisthenoisefrom: 'blank' });
  });

  it('new_question: visible live but not in the seed (also for a category with no seed questions)', () => {
    const out = auditFiling({ category: 'noise', reportId: 'r1', at: AT1, prev: null, controls: [...liveFromSeed('noise'), ctl('cop_decibels', 'How loud', ['Loud', 'Very loud'])], scouted: { cop_whereisthenoisefrom: 'House' } });
    expect(out.flags.map((f) => `${f.kind}:${f.questionId}`)).toEqual(['new_question:cop_decibels']);
    expect(out.doc.questions.find((q) => q.id === 'cop_decibels')).toMatchObject({ inSeed: false, cityOptions: ['Loud', 'Very loud'], counts: { blank: 1 } });
    const street = auditFiling({ category: 'street_light', reportId: 'r2', at: AT1, prev: null, controls: [ctl('cop_streetlightrepair', 'Street Light Repair', ['Light is out'])] });
    expect(street.flags.map((f) => f.kind)).toEqual(['new_question']);
  });

  it('gone: in the seed, not visible live (hidden counts as gone; toggles never flag)', () => {
    const hidden = liveFromSeed('graffiti').map((c) => (c.id === 'cop_surfacetype' ? { ...c, visible: false } : c));
    const out = auditFiling({ category: 'graffiti', reportId: 'r1', at: AT1, prev: null, controls: hidden });
    expect(out.flags.map((f) => `${f.kind}:${f.questionId}`)).toEqual(['gone:cop_surfacetype']);
  });

  it('options_changed: added and removed vs the seed (order does not matter)', () => {
    const live = [ctl('cop_whereisthenoisefrom', 'Where is the noise from', ['Car', 'House', 'Business (add name to description)', 'Park (add name to description)', 'Construction'])];
    const out = auditFiling({ category: 'noise', reportId: 'r1', at: AT1, prev: null, controls: live });
    expect(out.flags).toHaveLength(1);
    expect(out.flags[0]).toMatchObject({ kind: 'options_changed', questionId: 'cop_whereisthenoisefrom', added: ['Construction'], removed: ['Other (add to description)'] });
    expect(out.doc.questions[0].cityOptions).toContain('Construction'); // the record shows the latest live choices
    const reordered = auditFiling({ category: 'noise', reportId: 'r2', at: AT1, prev: null, controls: [ctl('cop_whereisthenoisefrom', 'x', [...SEED.categories.noise[0].cityOptions].reverse())] });
    expect(reordered.flags).toEqual([]);
  });

  it('app_option_stale: an app choice (or the default) the city no longer offers', () => {
    const live = [ctl('cop_size', 'Size', ['Small (~4in)', 'Medium (~28in)', 'Large (~36in)'])]; // "Unknown" dropped — also the default
    const out = auditFiling({ category: 'pothole', reportId: 'r1', at: AT1, prev: null, controls: live });
    expect(out.flags.map((f) => f.kind).sort()).toEqual(['app_option_stale', 'options_changed']);
    expect(out.flags.find((f) => f.kind === 'app_option_stale')).toMatchObject({ questionId: 'cop_size', removed: ['Unknown'] });
    // radio options keep the aria-label prefix; the app's plain option still matches (as Portal.setControl does)
    const carts = auditFiling({ category: 'bins_carts', reportId: 'r2', at: AT1, prev: null, controls: liveFromSeed('bins_carts') });
    expect(carts.flags).toEqual([]);
  });

  it('idempotent per report id; merges across filings; keeps firstAt; drops a flag once it clears', () => {
    const drift = [ctl('cop_whereisthenoisefrom', 'Where is the noise from', ['House'])];
    const a = auditFiling({ category: 'noise', reportId: 'r1', at: AT1, prev: null, controls: drift, scouted: { cop_whereisthenoisefrom: 'House' } });
    const again = auditFiling({ category: 'noise', reportId: 'r1', at: AT2, prev: a.doc, controls: drift, scouted: { cop_whereisthenoisefrom: 'House' } });
    expect(again.skipped).toBe(true);
    expect(again.doc).toBe(a.doc);
    const b = auditFiling({ category: 'noise', reportId: 'r2', at: AT2, prev: a.doc, controls: drift, leftBlank: ['Where is the noise from'] });
    expect(b.doc.filings).toBe(2);
    expect(b.doc.questions[0].counts).toEqual({ app: 0, ai: 1, blank: 1 });
    expect(b.flags[0]).toMatchObject({ kind: 'options_changed', firstAt: AT1, lastAt: AT2 });
    expect(b.newFlags).toEqual([]);
    const c = auditFiling({ category: 'noise', reportId: 'r3', at: AT2, prev: b.doc, controls: liveFromSeed('noise') });
    expect(c.flags).toEqual([]);
    expect(c.doc.auditedIds).toEqual(['r1', 'r2', 'r3']);
  });
});

function memStore(over: Partial<Store> = {}) {
  const docs: Record<string, CityQuestionsDoc> = {};
  const events: { level: string; kind: string; msg: string; data?: Record<string, unknown> | null }[] = [];
  const store = {
    getCityQuestions: vi.fn(async (c: string) => docs[c] ?? null),
    setCityQuestions: vi.fn(async (c: string, d: Record<string, unknown>) => { docs[c] = d as unknown as CityQuestionsDoc; }),
    listCityQuestions: vi.fn(async () => Object.values(docs)),
    addEvent: vi.fn(async (e: (typeof events)[number]) => { events.push(e); }),
    ...over,
  } as unknown as Store;
  return { store, docs, events };
}

describe('auditCityQuestions (engine hook)', () => {
  it('persists cityQuestions/{category}; logs questions.drift (warn) only when there are flags', async () => {
    const { store, docs, events } = memStore();
    await auditCityQuestions(store, { category: 'noise', reportId: 'r1', controls: liveFromSeed('noise'), scouted: { cop_whereisthenoisefrom: 'Car' }, at: AT1 });
    expect(docs.noise.questions[0].counts.ai).toBe(1);
    expect(events).toEqual([]);
    await auditCityQuestions(store, { category: 'noise', reportId: 'r2', controls: [ctl('cop_noisesource', 'Where is the noise coming from?', ['Residence'])], at: AT2 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ level: 'warn', kind: 'questions.drift' });
    expect(events[0].msg).toMatch(/new question .*cop_noisesource.*no longer shown/);
  });

  it('never throws: a failing read, write or event log resolves (null or result), and a hung store is time-boxed', async () => {
    const boom = async () => { throw new Error('firestore down'); };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(auditCityQuestions(memStore({ setCityQuestions: vi.fn(boom) }).store, { category: 'noise', reportId: 'r1', controls: liveFromSeed('noise') })).resolves.toBeNull();
    await expect(auditCityQuestions(memStore({ getCityQuestions: vi.fn(boom) }).store, { category: 'noise', reportId: 'r1', controls: liveFromSeed('noise') })).resolves.not.toBeNull(); // read failure = start fresh
    await expect(auditCityQuestions(memStore({ addEvent: vi.fn(boom) }).store, { category: 'noise', reportId: 'r1', controls: [] })).resolves.not.toBeUndefined();
    await expect(auditCityQuestions(memStore({ getCityQuestions: vi.fn(() => new Promise(() => {})) as never }).store, { category: 'noise', reportId: 'r1', controls: [] }, 50)).resolves.toBeNull();
    // garbage input (a control with no options/label) must not throw either
    await expect(auditCityQuestions(memStore().store, { category: 'nope', reportId: 'r1', controls: [{ id: 'cop_x', visible: true } as unknown as PortalControl] })).resolves.not.toBeUndefined();
    err.mockRestore();
  });
});

describe('admin view + digest', () => {
  const rec = (category: string, blank: number, flags: CityQuestionsDoc['flags'] = [], q: Partial<SeedQuestion> = {}): CityQuestionsDoc => ({
    category, flags, lastFiledAt: AT1, filings: blank, auditedIds: [], updatedAt: AT1,
    questions: [{ ...(SEED.categories[category]?.[0] ?? { id: 'cop_x', cityLabel: 'X', cityOptions: [], type: 'text' }), ...q, inSeed: true, lastSeenLive: AT1, counts: { app: 0, ai: 0, blank } }],
  });

  it('lists every seeded category (seed only until filed), ranked by blanks × demand, then demand', () => {
    const view = buildAdminView([rec('noise', 2), rec('tree', 1)]); // noise demand 5 → 10; tree demand 33 → 33
    expect(view.items).toHaveLength(27);
    expect(view.items[0].category).toBe('tree');
    expect(view.items[1].category).toBe('noise');
    expect(view.items[1]).toMatchObject({ blanks: 2, score: 10, filings: 2, lastFiledAt: AT1 });
    // unfiled categories follow by demand: missed_trash (27/wk) heads them, with its script-error note
    expect(view.items[2]).toMatchObject({ category: 'missed_trash', blanks: 0, lastFiledAt: null, questions: [] });
    expect(view.items[2].note).toMatch(/broken/);
    const pothole = view.items.find((i) => i.category === 'pothole')!;
    expect(pothole.questions[0]).toMatchObject({ id: 'cop_size', mode: 'app', lastSeenLive: null, counts: { app: 0, ai: 0, blank: 0 } });
    expect(pothole.questions[0].appOptions).toContain('Unknown');
    expect(view.items.find((i) => i.category === 'noise')!.questions[0].mode).toBe('ai');
  });

  it('digest: new flags and new blanks mail once', () => {
    const flag = { kind: 'gone' as const, questionId: 'cop_whereisthenoisefrom', label: 'Where is the noise from', firstAt: AT1, lastAt: AT1 };
    const first = questionsDigest([rec('noise', 1, [flag]), rec('pothole', 0)], null);
    expect(first.lines).toHaveLength(1);
    expect(first.lines[0]).toMatch(/^Noise.*no longer shown · 1 more blank answer \(1 total\)$/);
    const second = questionsDigest([rec('noise', 1, [flag]), rec('pothole', 0)], first.state);
    expect(second.lines).toEqual([]);
    const third = questionsDigest([rec('noise', 3, [flag])], second.state);
    expect(third.lines).toEqual([`${CATEGORIES.noise.label}: 2 more blank answers (3 total)`]);
  });

  it('GET /api/admin/city-questions: admin only; returns the ranked view', async () => {
    const { store } = memStore();
    await store.setCityQuestions('noise', rec('noise', 2) as unknown as Record<string, unknown>);
    const env = { ADMIN_EMAILS: 'rob@example.com' } as never;
    const req = () => new Request('https://api.test/api/admin/city-questions');
    const admin = { uid: 'u', email: 'rob@example.com', emailVerified: true, name: null, provider: 'google.com' };
    const ok = await handleAdmin(req(), new URL(req().url), env, store, admin);
    expect(ok.status).toBe(200);
    const j = await ok.json() as { items: { category: string; score: number }[]; seed: { dump: string } };
    expect(j.items[0]).toMatchObject({ category: 'noise', score: 10 });
    expect(j.seed.dump).toMatch(/step3-page-2026-10-16/);
    expect((await handleAdmin(req(), new URL(req().url), env, store, { ...admin, email: 'x@example.com' })).status).toBe(403);
    expect((await handleAdmin(req(), new URL(req().url), env, store, null)).status).toBe(401);
  });
});
