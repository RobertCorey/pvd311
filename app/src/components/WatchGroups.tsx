import { useEffect, useId, useRef, useState } from 'react';
import { GROUP_ORDER } from '@shared/categories';
import { useT } from '../i18n';
import { updateMe, type Me } from '../api/me';
import { track } from '../lib/analytics';
import { GROUP_ICON, type GroupKey } from '../lib/categories';
import CategoryIcon from './CategoryIcon';
import './StreetParts.css';

/** "Only tell me about…": prefs.watchGroups — the case-type groups the street watch (the instant pushes, morning
 *  catch-up included) AND the Monday street digest are limited to. One compact chip rail: All + the ten groups in
 *  GROUP_ORDER (CategoryIcon + the street.g.* label), multi-select with aria-pressed. The empty selection means
 *  everything and shows All pressed; tapping All clears; the selection is kept in GROUP_ORDER order so the PATCH body
 *  is stable. Optimistic: the chips flip at once and ONE PATCH /api/me {prefs:{watchGroups}} goes out 400 ms after the
 *  last tap (taps during the flight simply schedule the next); the Worker's answer goes to the parent, and a failure
 *  puts the saved selection back and says so. Only the LATEST save's answer may settle the rail and refresh the parent:
 *  a superseded PATCH answering late (slow link, the next tap's PATCH answered first) is dropped, since its snapshot of
 *  the account predates the selection the Worker now holds — it is kept only as the revert target if the latest save then
 *  fails, so the rail falls back to what the Worker did take rather than the pre-burst selection. An unmount with a tap
 *  still waiting sends it right away (best effort).
 *  Lives under the StreetWatchRow: in the digest card's on-state (/street point and case card, the tracking page) and
 *  in Account → Updates while the watch or the digest is on — the parents decide; the rail itself only needs `me`. */

export const SAVE_DEBOUNCE_MS = 400;

export interface WatchGroupsProps {
  me: Me | null;
  /** Receives the Worker's answer to the PATCH (the parent owns the account state). */
  onMe: (me: Me) => void;
  /** Analytics only: where the rail lives. */
  from: 'street' | 'case' | 'account' | 'track';
  /** Element id on the rail (Account → Updates: the summary's "Only about" line jumps here). */
  id?: string;
}

const isGroup = (g: unknown): g is GroupKey => typeof g === 'string' && (GROUP_ORDER as string[]).includes(g);

export default function WatchGroups({ me, onMe, from, id }: WatchGroupsProps) {
  const t = useT();
  const titleId = useId();
  const hintId = useId();
  const [local, setLocal] = useState<GroupKey[] | null>(null); // the optimistic selection while a save waits or is in flight
  const [error, setError] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gen = useRef(0); // bumps on every tap: a save's outcome settles the rail only when no tap followed it
  const waiting = useRef<GroupKey[] | null>(null); // a selection whose PATCH has not left yet (flushed on unmount)
  const selRef = useRef<GroupKey[]>([]); // the selection as of the last tap, so two taps in one task build on each other
  const settled = useRef(0); // the generation whose answer the parent holds (the latest success, or the revert target after a failure)
  const failed = useRef(0); // the generation whose failure the rail last showed
  const spare = useRef<{ g: number; me: Me } | null>(null); // the newest answer a superseded save brought back since `settled`: the revert target should the latest save fail

  useEffect(() => () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const left = waiting.current;
    if (left) { waiting.current = null; updateMe({ prefs: { watchGroups: left } }).catch(() => { /* best effort */ }); }
  }, []);

  if (!me) return null;
  const saved = (me.prefs.watchGroups ?? []).filter(isGroup);
  const sel = local ?? saved;
  selRef.current = sel;

  async function save(next: GroupKey[], g: number) {
    try {
      const fresh = await updateMe({ prefs: { watchGroups: next } });
      if (g !== gen.current) {
        // Superseded: a newer tap's save settles the rail AND the parent's account state — this snapshot predates it and
        // would roll both back (the Worker already holds the newer selection). Kept only as the newest revert target.
        if (g > settled.current && (!spare.current || g > spare.current.g)) {
          spare.current = { g, me: fresh };
          if (gen.current === failed.current) { settled.current = g; spare.current = null; onMe(fresh); } // the newer save already failed: show what the Worker did take
        }
        return;
      }
      settled.current = g; spare.current = null;
      onMe(fresh); setLocal(null);
      track('watch_groups', { n: next.length, from });
    } catch {
      if (g !== gen.current) return; // a newer tap's save decides
      failed.current = g;
      const back = spare.current;
      if (back) { settled.current = back.g; spare.current = null; onMe(back.me); } // back to the last selection the Worker did take, not the pre-burst one
      setLocal(null); setError(true);
    }
  }
  function pick(next: GroupKey[]) {
    gen.current += 1;
    const g = gen.current;
    waiting.current = next; selRef.current = next;
    setLocal(next); setError(false);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; waiting.current = null; void save(next, g); }, SAVE_DEBOUNCE_MS);
  }
  const toggle = (g: GroupKey) => { const cur = selRef.current; pick(cur.includes(g) ? cur.filter((x) => x !== g) : GROUP_ORDER.filter((x) => x === g || cur.includes(x))); };
  const clear = () => { if (selRef.current.length) pick([]); };

  return (
    <div className="watch-groups" id={id} data-n={sel.length}>
      <p className="watch-groups-title" id={titleId}>{t('watch.groups.title')}</p>
      <div className="street-rail watch-groups-rail" role="group" aria-labelledby={titleId} aria-describedby={hintId}>
        <button type="button" className="chip street-chip watch-chip watch-chip-all" aria-pressed={sel.length === 0} onClick={clear}>
          <span className="street-chip-label">{t('watch.groups.all')}</span>
        </button>
        {GROUP_ORDER.map((g) => (
          <button key={g} type="button" className="chip street-chip watch-chip" data-group={g} aria-pressed={sel.includes(g)} onClick={() => toggle(g)}>
            <CategoryIcon k={GROUP_ICON[g]} size={18} />
            <span className="street-chip-label">{t(`street.g.${g}`)}</span>
          </button>
        ))}
      </div>
      <p className="hint watch-groups-hint" id={hintId}>{t('watch.groups.hint')}</p>
      {error && <p className="hint watch-error" role="alert">{t('watch.groups.error')}</p>}
    </div>
  );
}
