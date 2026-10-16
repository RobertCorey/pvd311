/**
 * cityquestions.ts — phase 1 ("See it") of docs/city-questions.md: read-only visibility + alerts.
 *
 * SEED. shared/city-questions.seed.json, generated ONCE by scripts/city-questions-seed.mjs from a Step-3 page dump
 * (the city's own show/hide switch). It is the committed expectation of which questions each category's city form
 * shows. Nothing here parses city text at runtime.
 *
 * AUDIT. After every successful live submit (engine.submitOne), `auditCityQuestions` compares the Step-3 controls the
 * bot actually saw (SubmitResult.controls, VISIBLE only) with the seed for that category and records how this filing
 * answered each question:
 *   app    — a category `fields` mapping set it (the reporter answered in the app, or its default);
 *   ai     — the scout set a value (SubmitResult.scouted);
 *   blank  — nothing set it (scout unsure → SubmitResult.leftBlank, or it returned no value; or an on/off toggle,
 *            which the bot's control collector never sees, so it stays at the city's default).
 * Flags (vs the seed, plus the app's own options):
 *   new_question      — visible live, not in the seed;
 *   gone              — in the seed, not visible live (toggles excluded: the collector can't see them);
 *   options_changed   — the option set differs from the seed's;
 *   app_option_stale  — an option the app can send (EXTRA_QUESTIONS choice or the mapping's default) is no longer a
 *                       live option of that control (matched the way Portal.setControl matches).
 * A flag stays on the record while the condition holds on the latest filing (firstAt kept), and drops when it clears.
 *
 * Persisted as cityQuestions/{category}, merged and idempotent per report id. Never throws into the submit path:
 * `auditCityQuestions` catches everything and is time-boxed.
 */
import seedJson from '../../shared/city-questions.seed.json';
import { CATEGORIES, EXTRA_QUESTIONS, type FieldSource } from '../../shared/categories.js';
import type { Store } from './contracts.js';
import type { PortalControl } from './scout.js';
import { logEvent } from './health.js';

export type QuestionType = 'select' | 'radio' | 'checkbox' | 'text' | 'textarea' | 'toggle';
export interface SeedQuestion { id: string; cityLabel: string; cityOptions: string[]; type: QuestionType }
export interface CityQuestionsSeed {
  generatedAt: string;
  source: { dump: string; how: string; generator: string; ignored: string[] };
  notes: string[];
  categoryNotes: Record<string, string>;
  caseTypes: Record<string, { comment: string; categories: string[]; shows: string[]; error?: string; notOnPage?: string[] }>;
  categories: Record<string, SeedQuestion[]>;
}
export const SEED = seedJson as unknown as CityQuestionsSeed;

export type AnswerMode = 'app' | 'ai' | 'blank';
export interface QuestionRecord extends SeedQuestion {
  inSeed: boolean;
  lastSeenLive: string | null;
  counts: Record<AnswerMode, number>;
}
export type FlagKind = 'new_question' | 'gone' | 'options_changed' | 'app_option_stale';
export interface CityQuestionFlag {
  kind: FlagKind;
  questionId: string;
  label: string;
  /** options_changed: added/removed vs the seed. app_option_stale: `removed` = the app options the city no longer offers. */
  added?: string[];
  removed?: string[];
  firstAt: string;
  lastAt: string;
}
export interface CityQuestionsDoc {
  category: string;
  questions: QuestionRecord[];
  flags: CityQuestionFlag[];
  lastFiledAt: string | null;
  filings: number;
  /** Report ids already counted (newest last, capped) — a re-run for the same report is a no-op. */
  auditedIds: string[];
  updatedAt: string;
}

/** Not questions: disclaimers and the site-search controls the collector also picks up. */
export function isIgnoredControl(id: string): boolean {
  return SEED.source.ignored.includes(id) || id === 'q' || id.startsWith('filter-'); // seed `ignored` = the two light disclaimers
}

function kindOf(c: Pick<PortalControl, 'tag' | 'type'>): QuestionType {
  if (c.tag === 'select') return 'select';
  if (c.tag === 'textarea') return 'textarea';
  if (c.type === 'radio') return 'radio';
  if (c.type === 'checkbox') return 'checkbox';
  return 'text';
}

/** Does the city's live option `live` accept the value `want`? Mirrors Portal.setControl: select by exact label;
 * radio by the member's aria-label, which equals the option text or ends with " <option>". The collector splits each
 * radio aria-label into the group `label` (its first word) + the rest, so the aria-label is rebuilt from both. */
export function optionAccepts(type: QuestionType, live: string, want: string, label = ''): boolean {
  const l = live.trim().toLowerCase(); const w = want.trim().toLowerCase();
  if (type !== 'radio') return l === w;
  const aria = label ? `${label.trim().toLowerCase()} ${l}` : l;
  return [l, aria].some((x) => x === w || x.endsWith(' ' + w));
}

/** Values the app can send for each mapped control of a category: EXTRA_QUESTIONS choices + the mapping's default/constant. */
export function appOptions(category: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [id, src] of Object.entries(CATEGORIES[category]?.fields ?? {}) as [string, FieldSource][]) {
    const vals = new Set<string>();
    if ('value' in src) vals.add(src.value);
    else {
      const key = src.from.startsWith('extra.') ? src.from.slice('extra.'.length) : null;
      const q = key ? EXTRA_QUESTIONS[key] : undefined;
      if (q?.type === 'choice') for (const o of q.options ?? []) vals.add(o);
      if (src.default !== undefined) vals.add(src.default);
    }
    out[id] = [...vals];
  }
  return out;
}

const zero = (): Record<AnswerMode, number> => ({ app: 0, ai: 0, blank: 0 });
const sameSet = (a: string[], b: string[]) => { const A = new Set(a.map((s) => s.trim())); const B = new Set(b.map((s) => s.trim())); return A.size === B.size && [...A].every((x) => B.has(x)); };
const AUDITED_CAP = 200;

export interface AuditInput {
  category: string;
  reportId: string;
  at: string;
  controls: PortalControl[];
  scouted?: Record<string, string> | null;
  leftBlank?: string[] | null;
  prev: CityQuestionsDoc | null;
  seed?: SeedQuestion[];
  /** Override for tests; default = the category's `fields` mappings. */
  appMapped?: Record<string, string[]>;
}
export interface AuditOutput { doc: CityQuestionsDoc; flags: CityQuestionFlag[]; newFlags: CityQuestionFlag[]; answered: Record<string, AnswerMode>; skipped: boolean }

/** Pure: fold one live filing into the category's record. */
export function auditFiling(input: AuditInput): AuditOutput {
  const { category, reportId, at, prev } = input;
  const seed = input.seed ?? SEED.categories[category] ?? [];
  const mapped = input.appMapped ?? appOptions(category);
  if (prev?.auditedIds?.includes(reportId)) return { doc: prev, flags: prev.flags ?? [], newFlags: [], answered: {}, skipped: true };

  // Start from the stored record, then make sure every seed question is present (a regenerated seed may add some).
  const qs = new Map<string, QuestionRecord>();
  for (const q of prev?.questions ?? []) qs.set(q.id, { ...q, counts: { ...zero(), ...q.counts } });
  for (const s of seed) {
    const have = qs.get(s.id);
    if (have) have.inSeed = true;
    else qs.set(s.id, { ...s, cityOptions: [...s.cityOptions], inSeed: true, lastSeenLive: null, counts: zero() });
  }
  for (const q of qs.values()) if (!seed.some((s) => s.id === q.id)) q.inSeed = false;

  const visible = input.controls.filter((c) => c.visible && !isIgnoredControl(c.id));
  const blankLabels = new Set((input.leftBlank ?? []).map((l) => l.trim().toLowerCase()));
  const answered: Record<string, AnswerMode> = {};
  for (const c of visible) {
    let q = qs.get(c.id);
    if (!q) { q = { id: c.id, cityLabel: c.label, cityOptions: [], type: kindOf(c), inSeed: false, lastSeenLive: null, counts: zero() }; qs.set(c.id, q); }
    q.cityLabel = c.label || q.cityLabel;
    q.cityOptions = [...(c.options ?? [])];
    q.type = kindOf(c);
    q.lastSeenLive = at;
    const scoutVal = input.scouted?.[c.id];
    const mode: AnswerMode = c.id in mapped ? 'app'
      : scoutVal !== undefined && String(scoutVal).trim() !== '' && !blankLabels.has((c.label || c.id).trim().toLowerCase()) ? 'ai'
      : 'blank';
    q.counts[mode]++;
    answered[c.id] = mode;
  }
  // Toggles never appear in the bot's dump: they stay at the city's default, i.e. unanswered by us.
  for (const s of seed) if (s.type === 'toggle' && !(s.id in answered)) { qs.get(s.id)!.counts.blank++; answered[s.id] = 'blank'; }

  // Flags vs the seed (+ the app's options).
  const live = new Map(visible.map((c) => [c.id, c]));
  const found: Omit<CityQuestionFlag, 'firstAt' | 'lastAt'>[] = [];
  for (const c of visible) if (!seed.some((s) => s.id === c.id)) found.push({ kind: 'new_question', questionId: c.id, label: c.label });
  for (const s of seed) {
    if (s.type === 'toggle') continue;
    const c = live.get(s.id);
    if (!c) { found.push({ kind: 'gone', questionId: s.id, label: s.cityLabel }); continue; }
    const liveOpts = c.options ?? [];
    if (!sameSet(s.cityOptions, liveOpts)) {
      const L = new Set(liveOpts.map((o) => o.trim())); const S = new Set(s.cityOptions.map((o) => o.trim()));
      found.push({ kind: 'options_changed', questionId: s.id, label: c.label || s.cityLabel, added: [...L].filter((o) => !S.has(o)), removed: [...S].filter((o) => !L.has(o)) });
    }
  }
  for (const [id, opts] of Object.entries(mapped)) {
    const c = live.get(id);
    if (!c || !c.options?.length) continue; // gone is its own flag; free text has no options to go stale
    const type = kindOf(c);
    const stale = opts.filter((o) => !c.options!.some((lo) => optionAccepts(type, lo, o, c.label)));
    if (stale.length) found.push({ kind: 'app_option_stale', questionId: id, label: c.label, removed: stale });
  }
  const key = (f: { kind: string; questionId: string }) => `${f.kind}:${f.questionId}`;
  const before = new Map((prev?.flags ?? []).map((f) => [key(f), f]));
  const flags: CityQuestionFlag[] = found.map((f) => ({ ...f, firstAt: before.get(key(f))?.firstAt ?? at, lastAt: at }));
  const newFlags = flags.filter((f) => !before.has(key(f)));

  const order = new Map(seed.map((s, i) => [s.id, i]));
  const questions = [...qs.values()].sort((a, b) => (order.get(a.id) ?? 1e6) - (order.get(b.id) ?? 1e6) || a.id.localeCompare(b.id));
  const doc: CityQuestionsDoc = {
    category, questions, flags, lastFiledAt: at, filings: (prev?.filings ?? 0) + 1,
    auditedIds: [...(prev?.auditedIds ?? []), reportId].slice(-AUDITED_CAP), updatedAt: at,
  };
  return { doc, flags, newFlags, answered, skipped: false };
}

const flagText = (f: CityQuestionFlag) =>
  f.kind === 'new_question' ? `new question "${f.label}" (${f.questionId})`
  : f.kind === 'gone' ? `"${f.label}" (${f.questionId}) no longer shown`
  : f.kind === 'options_changed' ? `"${f.label}" choices changed${f.added?.length ? ` +[${f.added.join(' | ')}]` : ''}${f.removed?.length ? ` −[${f.removed.join(' | ')}]` : ''}`
  : `app sends "${(f.removed ?? []).join('", "')}" for "${f.label}" but the city no longer offers it`;
export const describeFlag = flagText;

/**
 * Engine hook (after a successful live submit). Reads cityQuestions/{category}, folds this filing in, writes it back,
 * logs `questions.drift` (warn) when the filing has flags. Never throws; gives up after `timeoutMs`.
 */
export async function auditCityQuestions(
  store: Store,
  args: { category: string; reportId: string; controls: PortalControl[]; scouted?: Record<string, string> | null; leftBlank?: string[] | null; at?: string },
  timeoutMs = 8_000,
): Promise<AuditOutput | null> {
  const work = (async () => {
    const prev = await store.getCityQuestions(args.category).catch(() => null);
    const out = auditFiling({ ...args, at: args.at ?? new Date().toISOString(), prev });
    if (out.skipped) return out;
    await store.setCityQuestions(args.category, out.doc as unknown as Record<string, unknown>);
    if (out.flags.length) {
      await logEvent(store, {
        level: 'warn', kind: 'questions.drift', reportId: args.reportId,
        msg: `City questions for ${args.category}: ${out.flags.map(flagText).join('; ')}${out.newFlags.length ? ` (${out.newFlags.length} new)` : ''}`,
        data: { category: args.category, flags: out.flags, newFlags: out.newFlags.map((f) => `${f.kind}:${f.questionId}`) },
      });
    }
    return out;
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((res) => { timer = setTimeout(() => res(null), timeoutMs); });
  try {
    return await Promise.race([work.catch((e) => { console.error('[questions] audit failed:', e instanceof Error ? e.message : e); return null; }), timeout]);
  } catch (e) {
    console.error('[questions] audit failed:', e instanceof Error ? e.message : e);
    return null;
  } finally { if (timer) clearTimeout(timer); }
}

// ── Admin view ─────────────────────────────────────────────────────────────────────────

export interface AdminQuestionRow extends QuestionRecord {
  /** How the engine answers it today: 'app' = a category `fields` mapping; 'ai' = the scout (blank when unsure). */
  mode: 'app' | 'ai';
  appOptions: string[] | null;
  seedLabel: string | null;
  seedOptions: string[] | null;
}
export interface AdminCityQuestionsItem {
  category: string; label: string; demand: number; caseTypeName: string; caseTypeGuid: string;
  note: string | null;
  questions: AdminQuestionRow[];
  flags: CityQuestionFlag[];
  lastFiledAt: string | null; filings: number;
  blanks: number; score: number;
}

/** Seed + live record per category, ranked by (blank count × weekly demand) desc, then demand, then label. */
export function buildAdminView(records: CityQuestionsDoc[], seed: CityQuestionsSeed = SEED): { seed: { generatedAt: string; dump: string; notes: string[] }; items: AdminCityQuestionsItem[] } {
  const byCat = new Map(records.map((r) => [r.category, r]));
  const keys = [...new Set([...Object.keys(seed.categories), ...records.map((r) => r.category)])].filter((k) => CATEGORIES[k]);
  const items = keys.map((key) => {
    const cfg = CATEGORIES[key];
    const rec = byCat.get(key) ?? null;
    const seedQs = seed.categories[key] ?? [];
    const mapped = appOptions(key);
    const qs = new Map<string, QuestionRecord>();
    for (const s of seedQs) qs.set(s.id, { ...s, inSeed: true, lastSeenLive: null, counts: zero() });
    for (const q of rec?.questions ?? []) qs.set(q.id, { ...q, inSeed: seedQs.some((s) => s.id === q.id), counts: { ...zero(), ...q.counts } });
    const questions: AdminQuestionRow[] = [...qs.values()].map((q) => {
      const s = seedQs.find((x) => x.id === q.id) ?? null;
      return { ...q, mode: q.id in mapped ? 'app' : 'ai', appOptions: mapped[q.id] ?? null, seedLabel: s?.cityLabel ?? null, seedOptions: s?.cityOptions ?? null };
    });
    const blanks = questions.reduce((n, q) => n + q.counts.blank, 0);
    const demand = cfg.demand ?? 0;
    return {
      category: key, label: cfg.label, demand, caseTypeName: cfg.portalCaseTypeName, caseTypeGuid: cfg.portalCaseTypeGuid,
      note: seed.categoryNotes[key] ?? null, questions, flags: rec?.flags ?? [], lastFiledAt: rec?.lastFiledAt ?? null, filings: rec?.filings ?? 0,
      blanks, score: blanks * demand,
    };
  }).sort((a, b) => b.score - a.score || b.demand - a.demand || a.label.localeCompare(b.label));
  return { seed: { generatedAt: seed.generatedAt, dump: seed.source.dump, notes: seed.notes }, items };
}

// ── Daily digest ───────────────────────────────────────────────────────────────────────

export interface QuestionsDigestState { cqBlanks?: Record<string, number>; cqFlags?: string[] }
/**
 * Lines for the daily digest: categories with flags not mailed before, or more blanks than at the last digest.
 * Returns the snapshot to store in meta/digest so each item mails once.
 */
export function questionsDigest(records: CityQuestionsDoc[], prev: QuestionsDigestState | null): { lines: string[]; state: Required<QuestionsDigestState> } {
  const seenFlags = new Set(prev?.cqFlags ?? []);
  const lastBlanks = prev?.cqBlanks ?? {};
  const lines: string[] = [];
  const cqBlanks: Record<string, number> = {};
  const cqFlags: string[] = [];
  for (const r of [...records].sort((a, b) => a.category.localeCompare(b.category))) {
    const blanks = (r.questions ?? []).reduce((n, q) => n + (q.counts?.blank ?? 0), 0);
    cqBlanks[r.category] = blanks;
    const fresh = (r.flags ?? []).filter((f) => { const k = `${r.category}:${f.kind}:${f.questionId}`; cqFlags.push(k); return !seenFlags.has(k); });
    const moreBlanks = blanks - (lastBlanks[r.category] ?? 0);
    if (!fresh.length && moreBlanks <= 0) continue;
    const parts: string[] = [];
    if (fresh.length) parts.push(fresh.map(flagText).join('; '));
    if (moreBlanks > 0) parts.push(`${moreBlanks} more blank answer${moreBlanks === 1 ? '' : 's'} (${blanks} total)`);
    lines.push(`${CATEGORIES[r.category]?.label ?? r.category}: ${parts.join(' · ')}`);
  }
  return { lines, state: { cqBlanks, cqFlags } };
}
