import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useT } from '../i18n';
import { getMe, saveAddress, updateMe, type Me } from '../api/me';
import { useSession } from '../lib/auth';
import { track } from '../lib/analytics';
import { metersBetween } from '../lib/streetMap';
import PushCard from './PushCard';
import './StreetParts.css';

/** "Hear about this street every week": the one-tap opt-in to the Monday street digest, bound to a point.
 *    signed out → a sign-in link that returns to `returnTo`
 *    signed in, off → ONE tap: PUT /api/me/addresses (unless a saved address is already this place) then
 *                     PATCH /api/me {prefs:{streetDigest:true}}; disabled until the account has loaded
 *    signed in, on  → "On — Mondays, for <label>", Turn off, and the "Notify me on this phone" row (PushCard)
 *  "This place" = a saved address within SAME_PLACE_M of the point, or the same address line (case-insensitive).
 *  Lives on /street (the point view and the case card) and on the tracking page's "Near this request" section.
 *  The account is either the parent's (`account`: /street shares one GET /api/me with its Follow toggle and the
 *  "Your places" row) or the card's own, loaded here while signed in. */

/** A saved address this close to the point counts as the same place (the digest is already on for it). */
export const SAME_PLACE_M = 60;

/** The saved address's short name for a full address line: the part before the first comma, at most 40 characters
 *  ('120 Benefit St, Providence, RI' → '120 Benefit St'). Blank when the line is blank (the card then uses its default). */
export const addressLabel = (address: string): string => address.split(',')[0].trim().slice(0, 40);

export interface StreetDigestCardProps {
  lat: number;
  lng: number;
  /** The saved address's short name (≤ 40 chars; see addressLabel). Blank → t('street.digest.defaultLabel'). */
  label: string;
  /** The full address line: saved as the address, and matched against the account's saved ones. */
  address: string;
  /** Analytics only: where the card lives. */
  from: 'point' | 'case' | 'track';
  /** Where the sign-in link returns to — the caller's exact URL (lib/auth takeReturnTo allowlist). */
  returnTo: string;
  /** Whether the on-state carries the "Notify me on this phone" row (off when a pressed Follow toggle on the same
   *  case card already shows it, so the card never has two). */
  push?: boolean;
  /** The parent's account state, when it already loads GET /api/me; the card reports PUT/PATCH results through
   *  `onMe`. Omitted → the card loads the account itself while signed in. */
  account?: { me: Me | null; onMe: (me: Me) => void };
}

export default function StreetDigestCard({ lat, lng, label, address, from, returnTo, push = true, account }: StreetDigestCardProps) {
  const t = useT();
  const session = useSession();
  const [ownMe, setOwnMe] = useState<Me | null>(null);
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle');
  const owned = account === undefined;
  useEffect(() => {
    if (!owned) return;
    if (!session) { setOwnMe(null); return; }
    let live = true;
    getMe().then((m) => { if (live) setOwnMe(m); }).catch(() => { /* the button stays disabled until a reload */ });
    return () => { live = false; };
  }, [owned, session]);
  const me = account ? account.me : ownMe;
  const setMe = account ? account.onMe : setOwnMe;

  const name = (label.trim() || t('street.digest.defaultLabel')).slice(0, 40);
  const line = address.trim().toLowerCase();
  const saved = me?.addresses.find((a) => (a.lat != null && a.lng != null && metersBetween(a.lat, a.lng, lat, lng) < SAME_PLACE_M) || (line !== '' && a.address.trim().toLowerCase() === line)) ?? null;
  const on = !!(me?.prefs.streetDigest && saved);
  const pushFrom = from === 'case' ? 'case' : from === 'track' ? 'track' : 'street';

  async function enable() {
    setState('saving');
    try {
      let addresses = me?.addresses ?? [];
      if (!saved) addresses = (await saveAddress({ label: name, address: address.trim() || name, lat, lng })).addresses;
      const fresh = await updateMe({ prefs: { streetDigest: true } });
      setMe({ ...fresh, addresses: fresh.addresses?.length ? fresh.addresses : addresses });
      setState('idle');
      track('street_digest_on', { from });
    } catch { setState('error'); }
  }
  async function disable() {
    setState('saving');
    try { setMe(await updateMe({ prefs: { streetDigest: false } })); setState('idle'); track('street_digest_off', { from }); } catch { setState('error'); }
  }

  return (
    <div className="card street-digest">
      <h3>{t('street.digest.title')}</h3>
      <p className="muted">{t('street.digest.body')}</p>
      {!session && <Link to={`/account?returnTo=${encodeURIComponent(returnTo)}`} className="btn btn-secondary">{t('street.digest.signIn')}</Link>}
      {session && !on && (
        <button type="button" className="btn btn-primary" onClick={() => void enable()} disabled={state === 'saving' || !me}>
          {state === 'saving' ? t('street.digest.saving') : t('street.digest.cta')}
        </button>
      )}
      {session && on && (
        <div className="street-digest-on">
          <p className="notice notice-ok" role="status">{t('street.digest.on', { label: saved?.label ?? name })}</p>
          <button type="button" className="btn btn-ghost" onClick={() => void disable()} disabled={state === 'saving'}>{t('street.digest.off')}</button>
          {push && <PushCard me={me} from={pushFrom} />}
        </div>
      )}
      {state === 'error' && <p className="hint" role="alert">{t('street.digest.error')}</p>}
    </div>
  );
}
