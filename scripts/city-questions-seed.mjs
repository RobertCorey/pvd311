#!/usr/bin/env node
/**
 * city-questions-seed.mjs — ONE-TIME generator for shared/city-questions.seed.json (phase 1 of
 * docs/city-questions.md). Run it again only when you have a fresh Step-3 page dump; the committed JSON is
 * what the Worker reads. Nothing parses the city's page at runtime: the per-filing control snapshot
 * (engine.ts → cityquestions.ts) is the live source of truth, and it is compared against this seed.
 *
 *   node scripts/city-questions-seed.mjs <step3-page-dump.json> [out.json]
 *
 * Input: a read-only Step-3 page dump (GET /admin/controls?entityId=<draft>&page=1 → Portal.inspectStep3Page),
 *   { controls[], inlineScripts[], formHtml }. One inline script holds the city's show/hide logic:
 *     switch (casetypeval) { case '<case-type GUID>' :/*name*\/showElements(elements.cop_x, …);break; … }
 *
 * How a question is described:
 *   - from `controls` (what the bot's own collector sees): label, options, kind (select | radio | text | textarea);
 *   - else, if the form HTML has a hidden input + <label for> for it, it is a Power Apps on/off toggle that the
 *     bot's collector never reports (type 'toggle', no options);
 *   - else the id is not on the page at all (the switch names it but nothing renders) → noted, not a question.
 * Faithful to the script's JS semantics: an argument that is not `elements.<id>` (the city's missed-trash case has
 * `elements.elements.cop_servicerequestnumber`) throws while the arguments are evaluated, so that case shows
 * NOTHING — recorded with an empty question list and a note.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES } from '../shared/categories.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [, , inPath, outArg] = process.argv;
if (!inPath) { console.error('usage: node scripts/city-questions-seed.mjs <step3-page-dump.json> [out.json]'); process.exit(2); }
const outPath = outArg ? resolve(outArg) : resolve(ROOT, 'shared/city-questions.seed.json');

/** Disclaimers are static text blocks, not questions. */
const IGNORE = new Set(['cop_streetlightdisclaimer', 'cop_decorativelightdisclaimer']);

const dump = JSON.parse(readFileSync(inPath, 'utf8'));
const script = (dump.inlineScripts ?? []).find((s) => /switch\s*\(\s*casetypeval\s*\)/.test(s));
if (!script) throw new Error('no inline script with `switch (casetypeval)` in the dump');
const body = script.slice(script.search(/switch\s*\(\s*casetypeval\s*\)/));

const CASE = /case\s+'([0-9a-f-]{36})'\s*:\s*(?:\/\*(.*?)\*\/)?\s*showElements\(([^)]*)\)\s*;\s*break\s*;/g;
const cases = [];
for (const m of body.matchAll(CASE)) cases.push({ guid: m[1].toLowerCase(), comment: (m[2] ?? '').trim(), args: m[3].split(',').map((a) => a.trim()).filter(Boolean) });
const caseCount = (body.match(/\bcase\s+'/g) ?? []).length;
if (cases.length !== caseCount) throw new Error(`parsed ${cases.length} of ${caseCount} switch cases — the script's shape changed; update this generator`);

const controls = new Map((dump.controls ?? []).map((c) => [c.id, c]));
const html = String(dump.formHtml ?? '');
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
function toggleLabel(id) {
  if (!new RegExp(`<input[^>]*type="hidden"[^>]*id="${id}"`).test(html)) return null;
  const m = new RegExp(`<label[^>]*for="${id}"[^>]*>([\\s\\S]*?)</label>`).exec(html);
  return m ? decode(m[1].replace(/<[^>]+>/g, '')).trim().replace(/\s+/g, ' ') : null;
}
function kind(c) {
  if (c.tag === 'select') return 'select';
  if (c.tag === 'textarea') return 'textarea';
  if (c.type === 'radio') return 'radio';
  if (c.type === 'checkbox') return 'checkbox';
  return 'text';
}

const notes = [];
const byGuid = {};
for (const { guid, comment, args } of cases) {
  const bad = args.find((a) => !/^elements\.cop_[a-z0-9_]+$/.test(a));
  const entry = { comment, shows: [], questions: [] };
  if (bad) {
    entry.error = `\`${bad}\` throws while showElements' arguments are evaluated, so this case shows nothing`;
    byGuid[guid] = entry;
    continue;
  }
  for (const a of args) {
    const id = a.slice('elements.'.length);
    entry.shows.push(id);
    if (IGNORE.has(id)) continue;
    const c = controls.get(id);
    if (c) { entry.questions.push({ id, cityLabel: c.label, cityOptions: c.options ?? [], type: kind(c) }); continue; }
    const label = toggleLabel(id);
    if (label) { entry.questions.push({ id, cityLabel: label, cityOptions: [], type: 'toggle' }); continue; }
    (entry.notOnPage ??= []).push(id);
  }
  byGuid[guid] = entry;
}

// Our categories → the switch. Several of ours may share one city case type.
const categories = {};
const categoryNotes = {};
const ours = new Map();
for (const [key, cfg] of Object.entries(CATEGORIES)) {
  const guid = String(cfg.portalCaseTypeGuid).toLowerCase();
  if (!byGuid[guid]) continue;
  const e = byGuid[guid];
  categories[key] = e.questions;
  const n = [];
  if (e.error) n.push(`The city's show/hide script is broken for this case type: ${e.error} (case comment "${e.comment}").`);
  if (e.notOnPage?.length) n.push(`The city's script shows ${e.notOnPage.join(', ')}, but no such control exists on the page.`);
  if (n.length) categoryNotes[key] = n.join(' ');
  (ours.get(guid) ?? ours.set(guid, []).get(guid)).push(key);
}
const caseTypes = Object.fromEntries(Object.entries(byGuid).map(([guid, e]) => [guid, {
  comment: e.comment, categories: ours.get(guid) ?? [], shows: e.shows,
  ...(e.error ? { error: e.error } : {}), ...(e.notOnPage ? { notOnPage: e.notOnPage } : {}),
}]));
const unused = Object.entries(caseTypes).filter(([, v]) => v.categories.length === 0);
if (unused.length) notes.push(`${unused.length} case type(s) in the city's switch match none of our categories: ${unused.map(([g, v]) => `${g} ("${v.comment}")`).join('; ')}.`);

const seed = {
  generatedAt: new Date().toISOString(),
  source: {
    dump: basename(inPath),
    how: "Step-3 page dump (Portal.inspectStep3Page, read-only); the city's inline `switch (casetypeval)` show/hide script decides which questions each case type shows; labels/options from the dumped controls; hidden-input Power Apps toggles from the form HTML.",
    generator: 'scripts/city-questions-seed.mjs',
    ignored: [...IGNORE],
  },
  notes,
  categoryNotes,
  caseTypes,
  categories,
};
writeFileSync(outPath, JSON.stringify(seed, null, 2) + '\n');
const qn = Object.values(categories).reduce((n, q) => n + q.length, 0);
console.log(`wrote ${outPath}: ${cases.length} switch case types, ${Object.keys(categories).length} of our categories, ${qn} questions; ${unused.length} unused case types`);
for (const n of [...notes, ...Object.entries(categoryNotes).map(([k, v]) => `${k}: ${v}`)]) console.log(' - ' + n);
