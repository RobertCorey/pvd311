import { useEffect, useId, useState } from 'react';
import { useT } from '../i18n';
import { getPushKey, registerPush, unregisterPush, type Me } from '../api/me';
import { track } from '../lib/analytics';
import { currentSubscription, pushSupport, subscribePush, swRegistration, unsubscribePush, type PushSupport } from '../lib/push';
import './StreetParts.css';

/** "Notify me on this phone": web push alongside the emails, as one compact row. Having a subscription on the account
 *  is the opt-in (no pref), so the state is read from the browser + `me.push.endpoints`:
 *    unsupported       → nothing rendered (no dead controls)
 *    ios-needs-install → the title and how to install (iOS Safari only pushes from a Home Screen app)
 *    blocked           → the title and that the browser blocked notifications
 *    off               → Turn on: Notification.requestPermission → subscribe with the Worker's VAPID key → POST /api/me/push
 *    on                → "On for this phone" + "Turn off on this phone": unsubscribe → DELETE /api/me/push
 *  `me` may lag (null while loading, or an older Worker without `push`): then the browser's own subscription decides.
 *  A subscription this browser holds that the account does not know (another account used this phone without signing
 *  out — lib/auth signOut() drops this phone's subscription) reads as off, and Turn on re-registers it without asking
 *  the browser again; the Worker then takes the endpoint off the previous account (one owner per phone). Rendered
 *  inside the digest card's on-state (/street and the tracking page) and under the pressed Follow toggle on /street,
 *  and in Account → Updates. */

/** The card's state as its `data-state` reads it: the support verdict, else whether this phone is on the account. */
export type PushState = PushSupport | 'on' | 'off';

export interface PushCardProps {
  me: Me | null;
  /** Analytics only: where the toggle lives ('track' = the digest card on the tracking page). */
  from: 'street' | 'case' | 'account' | 'track';
  /** Reports every state change to the parent (the street-watch row only arms itself while this phone is 'on').
   *  Called with 'unsupported' too, when the card renders nothing. */
  onState?: (state: PushState) => void;
}

export default function PushCard({ me, from, onState }: PushCardProps) {
  const t = useT();
  const titleId = useId();
  const [support, setSupport] = useState<PushSupport>(() => pushSupport());
  // This browser's subscription endpoint: undefined while being read, null when there is none.
  const [endpoint, setEndpoint] = useState<string | null | undefined>(undefined);
  // Endpoints this card registered itself (so the on-state does not wait for a fresh GET /api/me).
  const [registered, setRegistered] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (support !== 'ready') return;
    let live = true;
    currentSubscription(swRegistration()).then((s) => { if (live) setEndpoint(s?.endpoint ?? null); }).catch(() => { if (live) setEndpoint(null); });
    return () => { live = false; };
  }, [support]);

  const known = me?.push?.endpoints;
  const on = !!endpoint && (known == null || known.includes(endpoint) || registered.includes(endpoint));
  const state: PushState = support !== 'ready' ? support : on ? 'on' : 'off';
  useEffect(() => { onState?.(state); }, [state, onState]);

  async function enable() {
    if (busy || endpoint === undefined) return;
    setBusy(true); setError(false);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { setSupport(pushSupport()); return; } // denied → blocked copy; dismissed → still off
      const { publicKey } = await getPushKey();
      const json = await subscribePush(swRegistration(), publicKey);
      const p256dh = json.keys?.p256dh, auth = json.keys?.auth;
      if (!json.endpoint || !p256dh || !auth) throw new Error('bad_subscription');
      await registerPush({ endpoint: json.endpoint, keys: { p256dh, auth }, ua: navigator.userAgent.slice(0, 200) });
      setRegistered((r) => [...r, json.endpoint!]);
      setEndpoint(json.endpoint);
      track('push_on', { from });
    } catch { setError(true); } finally { setBusy(false); }
  }

  async function disable() {
    if (busy) return;
    setBusy(true); setError(false);
    try {
      const removed = await unsubscribePush(swRegistration());
      // The browser side is gone either way; a failed DELETE leaves a dead endpoint the Worker prunes on its next 410.
      if (removed) await unregisterPush(removed).catch(() => undefined);
      setEndpoint(null);
      track('push_off', { from });
    } catch { setError(true); } finally { setBusy(false); }
  }

  if (support === 'unsupported') return null;
  return (
    <div className="push-card" data-state={state}>
      <p className="push-title" id={titleId}>
        <svg className="push-bell" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20a2 2 0 0 0 4 0" /></svg>
        {t('push.title')}
      </p>
      {support === 'ios-needs-install' && <p className="hint push-hint">{t('push.iosInstall')}</p>}
      {support === 'blocked' && <p className="hint push-hint">{t('push.blocked')}</p>}
      {support === 'ready' && (
        <>
          {on
            ? <p className="push-on" role="status"><span className="push-check" aria-hidden="true">✓</span>{t('push.on')}</p>
            : <p className="hint push-hint">{t('push.body')}</p>}
          {/* ONE button for both states (its label, style and handler flip with `on`), so the node — and keyboard /
              screen-reader focus — survives the switch. Its off-state name is distinct from the digest card's own
              "Turn off" that sits right above it on /street. */}
          <button
            type="button"
            className={`btn ${on ? 'btn-ghost' : 'btn-secondary'} push-btn`}
            aria-describedby={titleId}
            aria-disabled={!on && endpoint === undefined ? true : undefined}
            aria-busy={busy || undefined}
            onClick={() => void (on ? disable() : enable())}
          >
            {t(on ? 'push.off' : 'push.enable')}
          </button>
        </>
      )}
      {error && <p className="hint push-error" role="alert">{t('push.error')}</p>}
    </div>
  );
}
