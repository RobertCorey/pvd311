import { useId, useState } from 'react';
import { useT } from '../i18n';
import { updateMe, type Me } from '../api/me';
import { track } from '../lib/analytics';
import type { PushState } from './PushCard';
import './StreetParts.css';

/** "Tell me right away when something new is reported near my places": the push-only street watch (prefs.streetWatch).
 *  The Worker's 30-minute city sync pushes one notification per new located case within 300 m of a saved address, to
 *  the account's subscribed phones only — never an email — so the row is armed only while the PushCard above it
 *  reports this phone as 'on':
 *    push on                 → an ordinary checkbox; the hint is the body copy, or the on-copy once checked
 *    push not on, watch off  → the checkbox is disabled and the hint says to turn phone notifications on first
 *    push not on, watch on   → checked and still enabled (set from another phone; it must stay possible to turn it
 *                              off here), with the same "turn notifications on first" hint: this phone gets nothing yet
 *    push unsupported, off   → nothing (there is no control above that could ever arm it)
 *    push unsupported, on    → checked and enabled, and the hint says this browser cannot get them (the PushCard
 *                              renders nothing here, so "turn notifications on first" would point at no control)
 *  Optimistic: the box flips at once and PATCH /api/me {prefs:{streetWatch}} confirms; a failure reverts and says so.
 *  Lives under the PushCard in the digest card's on-state (/street and the tracking page) and in Account → Updates. */

export interface StreetWatchRowProps {
  me: Me | null;
  /** Receives the Worker's answer to the PATCH (the parent owns the account state). */
  onMe: (me: Me) => void;
  /** What the PushCard above reports; undefined until its first report (the row stays disabled meanwhile). */
  pushState: PushState | undefined;
  /** Analytics only: where the row lives. */
  from: 'street' | 'case' | 'account' | 'track';
  /** Element id on the row (Account → Updates: the summary's phone line jumps here where no PushCard renders). */
  id?: string;
}

export default function StreetWatchRow({ me, onMe, pushState, from, id }: StreetWatchRowProps) {
  const t = useT();
  const hintId = useId();
  const [pending, setPending] = useState<boolean | null>(null); // the optimistic value while a PATCH is in flight
  const [error, setError] = useState(false);
  const saved = me?.prefs.streetWatch === true;
  const checked = pending ?? saved;
  const pushOn = pushState === 'on';
  if (pushState === 'unsupported' && !saved) return null;
  const enabled = !!me && (pushOn || saved);
  const hint = pushState === 'unsupported' ? t('watch.noPushHere') : !pushOn ? t('watch.needsPush') : checked ? t('watch.on') : t('watch.body');

  async function toggle(next: boolean) {
    if (!me || pending !== null) return;
    setPending(next); setError(false);
    try {
      onMe(await updateMe({ prefs: { streetWatch: next } }));
      track(next ? 'street_watch_on' : 'street_watch_off', { from });
    } catch { setError(true); } finally { setPending(null); }
  }

  return (
    <div className="watch-row" id={id} data-state={!pushOn ? 'needs-push' : checked ? 'on' : 'off'}>
      <label className="watch-toggle">
        <input type="checkbox" checked={checked} disabled={!enabled} aria-describedby={hintId} aria-busy={pending !== null || undefined} onChange={(e) => void toggle(e.target.checked)} />
        <span>{t('watch.title')}</span>
      </label>
      <p className="hint watch-hint" id={hintId}>{hint}</p>
      {error && <p className="hint watch-error" role="alert">{t('watch.error')}</p>}
    </div>
  );
}
