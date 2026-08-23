/**
 * drift.ts — the golden-controls drift canary's PURE core (no browser, no I/O).
 *
 * Two jobs, both deterministic and fully unit-testable (worker/test/drift.test.ts):
 *   1. normalize a raw Step-3 control dump (portal.ts `dumpControls`) into a stable
 *      `GoldenControl[]` — id, label, kind, required, options — with a canonical order.
 *   2. diff a stored golden against a fresh dump into a field-level `DriftDelta`:
 *      added / removed / renamed controls, changed-required, changed-options, changed-label.
 *
 * The engine's nightly canary (engine.runDriftCanary, flagged DRIFT_CANARY_ENABLED) re-dumps the
 * live portal, normalizes, diffs against the committed goldens, and emits `canary.drift` on any
 * change — so a drift is KNOWN before the next submit trusts a stale field mapping. This module
 * never touches the portal; it is pure data-in / data-out.
 */
import type { PortalControl } from './scout.js';

/**
 * Golden schema version. Bumped to 2 when the dump began including HIDDEN Step-3 controls (each with a
 * `visible` flag). A stored golden at a lower schema (or with the field missing) is not comparable to a
 * current dump — the shared control set it captured is a different shape — so the canary RE-MINTS the
 * next live dump instead of diffing across schemas (see engine.recordControls / canary-golden).
 */
export const GOLDEN_SCHEMA = 2;

/** A control's normalized kind. Collapses portal `tag`+`type` into one comparable dimension. */
export type ControlKind = 'select' | 'radio' | 'checkbox' | 'textarea' | 'text';

/** One normalized Step-3 control, as stored in a golden and compared by the canary. */
export interface GoldenControl {
  id: string;
  label: string;
  kind: ControlKind;
  required: boolean;
  /** Whether the portal is currently showing this control for the canary's case type. Hidden controls
   * (visible:false) are kept in the golden so a visibility flip is detectable as drift. */
  visible: boolean;
  /** Present for select/radio (the option/label list). Order is preserved for humans but compared as a set. */
  options?: string[];
}

/** A committed per-category snapshot: metadata + the normalized control list. */
export interface GoldenSnapshot {
  category: string;
  caseTypeName: string;
  /** How this golden was produced. `addendum` = hand-authored from research; `sim` = dumped from the mock; `live` = a real portal dump. */
  source: 'sim' | 'addendum' | 'live';
  /** Golden schema version (see GOLDEN_SCHEMA). Absent ⇒ pre-versioning (treat as 1). */
  schema?: number;
  /** ISO capture time, or null for hand-authored goldens. */
  capturedAt: string | null;
  controls: GoldenControl[];
}

export interface RenameDelta { from: string; to: string; label: string; kind: ControlKind }
export interface RequiredDelta { id: string; label: string; from: boolean; to: boolean }
export interface LabelDelta { id: string; from: string; to: string }
export interface OptionDelta { id: string; label: string; added: string[]; removed: string[] }
export interface VisibilityDelta { id: string; label: string; from: boolean; to: boolean }

/** The field-level difference between a golden and a fresh dump. Empty everywhere ⇒ no drift. */
export interface DriftDelta {
  added: GoldenControl[];
  removed: GoldenControl[];
  renamed: RenameDelta[];
  requiredChanged: RequiredDelta[];
  labelChanged: LabelDelta[];
  optionsChanged: OptionDelta[];
  /** A control that stayed but flipped shown⇄hidden — the shared set is unchanged, its wiring is not. */
  visibilityChanged: VisibilityDelta[];
}

// ── Normalization ──────────────────────────────────────────────────────────────────────

/** Collapse a raw portal control's tag/type into a single comparable kind. */
export function controlKind(c: Pick<PortalControl, 'tag' | 'type'>): ControlKind {
  if (c.tag === 'select') return 'select';
  if (c.tag === 'textarea') return 'textarea';
  if (c.type === 'radio') return 'radio';
  if (c.type === 'checkbox') return 'checkbox';
  return 'text';
}

/** Trim, drop empties + placeholder "Select", and de-dupe while preserving first-seen order. */
function cleanOptions(options: string[] | undefined): string[] | undefined {
  if (!options) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of options) {
    const o = (raw ?? '').replace(/\s+/g, ' ').trim();
    if (!o || o === 'Select' || seen.has(o)) continue;
    seen.add(o);
    out.push(o);
  }
  return out;
}

/** One raw control → its normalized golden form. */
export function normalizeControl(c: PortalControl): GoldenControl {
  const kind = controlKind(c);
  const g: GoldenControl = {
    id: c.id,
    label: (c.label ?? c.id).replace(/\s+/g, ' ').trim(),
    kind,
    required: !!c.required,
    // Pre-`visible` dumps (and hand-authored goldens) predate hidden capture — treat a missing flag as visible.
    visible: c.visible ?? true,
  };
  if (kind === 'select' || kind === 'radio') g.options = cleanOptions(c.options) ?? [];
  return g;
}

/** A raw dump → normalized controls in a stable, storage-ready order (sorted by id). */
export function normalizeControls(controls: PortalControl[]): GoldenControl[] {
  return controls.map(normalizeControl).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ── Diff ───────────────────────────────────────────────────────────────────────────────

export function emptyDelta(): DriftDelta {
  return { added: [], removed: [], renamed: [], requiredChanged: [], labelChanged: [], optionsChanged: [], visibilityChanged: [] };
}

/** true iff `a` and `b` hold the same option strings, regardless of order. */
function sameOptionSet(a: string[] | undefined, b: string[] | undefined): boolean {
  const sa = new Set(a ?? []);
  const sb = new Set(b ?? []);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

/** Options in `to` not in `from`, and in `from` not in `to` — order-insensitive. */
function optionDiff(from: string[] | undefined, to: string[] | undefined): { added: string[]; removed: string[] } {
  const sf = new Set(from ?? []);
  const st = new Set(to ?? []);
  return {
    added: (to ?? []).filter((o) => !sf.has(o)),
    removed: (from ?? []).filter((o) => !st.has(o)),
  };
}

const byId = (a: GoldenControl, b: GoldenControl) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Diff a stored golden against a fresh dump. Both are compared as maps keyed by id, so input
 * ORDER is irrelevant (a reordered-but-identical list yields no drift). A control that disappears
 * under one id and reappears under another with the SAME label+kind is reported as a rename, not an
 * add+remove. Callers should pass NORMALIZED lists (see `normalizeControls`); the diff itself does
 * not re-derive kinds.
 */
export function diffControls(golden: GoldenControl[], live: GoldenControl[]): DriftDelta {
  const delta = emptyDelta();
  const goldenMap = new Map(golden.map((c) => [c.id, c]));
  const liveMap = new Map(live.map((c) => [c.id, c]));

  // Same-id controls: compare label, required, visibility, options.
  for (const [id, g] of goldenMap) {
    const l = liveMap.get(id);
    if (!l) continue;
    if (g.label !== l.label) delta.labelChanged.push({ id, from: g.label, to: l.label });
    if (g.required !== l.required) delta.requiredChanged.push({ id, label: l.label, from: g.required, to: l.required });
    if (g.visible !== l.visible) delta.visibilityChanged.push({ id, label: l.label, from: g.visible, to: l.visible });
    if (!sameOptionSet(g.options, l.options)) {
      const { added, removed } = optionDiff(g.options, l.options);
      delta.optionsChanged.push({ id, label: l.label, added, removed });
    }
  }

  // Id-set differences, before rename reconciliation.
  const removedControls = [...goldenMap.values()].filter((c) => !liveMap.has(c.id));
  const addedControls = [...liveMap.values()].filter((c) => !goldenMap.has(c.id));

  // Rename reconciliation: pair a removed id with an added id sharing label+kind (greedy).
  const addedTaken = new Set<string>();
  for (const r of removedControls) {
    const match = addedControls.find(
      (a) => !addedTaken.has(a.id) && a.label === r.label && a.kind === r.kind,
    );
    if (match) {
      addedTaken.add(match.id);
      delta.renamed.push({ from: r.id, to: match.id, label: r.label, kind: r.kind });
    } else {
      delta.removed.push(r);
    }
  }
  for (const a of addedControls) if (!addedTaken.has(a.id)) delta.added.push(a);

  delta.added.sort(byId);
  delta.removed.sort(byId);
  delta.renamed.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  delta.requiredChanged.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  delta.labelChanged.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  delta.optionsChanged.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  delta.visibilityChanged.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return delta;
}

/** true iff the delta records any change at all. */
export function hasDrift(d: DriftDelta): boolean {
  return (
    d.added.length > 0 ||
    d.removed.length > 0 ||
    d.renamed.length > 0 ||
    d.requiredChanged.length > 0 ||
    d.labelChanged.length > 0 ||
    d.optionsChanged.length > 0 ||
    d.visibilityChanged.length > 0
  );
}

/** Total number of drifted fields across all categories of change. */
export function driftFieldCount(d: DriftDelta): number {
  return (
    d.added.length +
    d.removed.length +
    d.renamed.length +
    d.requiredChanged.length +
    d.labelChanged.length +
    d.optionsChanged.length +
    d.visibilityChanged.length
  );
}

/** A compact one-line human summary for the event/email (e.g. "pothole: +1 required, ~1 options"). */
export function summarizeDrift(category: string, d: DriftDelta): string {
  const parts: string[] = [];
  if (d.added.length) parts.push(`+${d.added.length} added${d.added.some((c) => c.required) ? ' (incl. required)' : ''}`);
  if (d.removed.length) parts.push(`-${d.removed.length} removed`);
  if (d.renamed.length) parts.push(`${d.renamed.length} renamed`);
  if (d.requiredChanged.length) parts.push(`${d.requiredChanged.length} required-changed`);
  if (d.labelChanged.length) parts.push(`${d.labelChanged.length} relabeled`);
  if (d.optionsChanged.length) parts.push(`${d.optionsChanged.length} options-changed`);
  if (d.visibilityChanged.length) parts.push(`${d.visibilityChanged.length} visibility-changed`);
  return `${category}: ${parts.join(', ') || 'no drift'}`;
}
