import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useT } from '../i18n';
import { saveAddress, setAddressDigest, type Me } from '../api/me';
import { useSession } from '../lib/auth';
import { track } from '../lib/analytics';
import { metersBetween } from '../lib/streetMap';
import './StreetParts.css';

/** "Email me Mondays about this street": the /street address view's one subscription control, bound to the point.
 *    signed out → a sign-in link that returns to `returnTo`
 *    signed in  → one switch (the saved address's `digest`) and "Manage" → Account → Updates, where every street is.
 *                 On: PUT /api/me/addresses — the saved address with digest true, or a new one for this point.
 *                 Off: the same PUT with digest false (the address stays saved). Disabled until the account has loaded.
 *  "This place" = a saved address within SAME_PLACE_M of the point, or the same address line (case-insensitive). */

/** A saved address this close to the point counts as the same place. */
export const SAME_PLACE_M = 60;

/** The saved address's short name for a full address line: the part before the first comma, at most 40 characters
 *  ('120 Benefit St, Providence, RI' → '120 Benefit St'). Blank when the line is blank (the card then uses its default). */
export const addressLabel = (address: string): string => address.split(',')[0].trim().slice(0, 40);

export interface StreetDigestCardProps {
  lat: number;
  lng: number;
  /** The address line: saved as the address (and its short label), and matched against the account's saved ones. */
  address: string;
  /** Where the sign-in link returns to — the caller's exact URL (lib/auth takeReturnTo allowlist). */
  returnTo: string;
  /** The page's account (null while loading); the PUT's addresses go back through `onMe`. */
  me: Me | null;
  onMe: (me: Me) => void;
}

export default function StreetDigestCard({ lat, lng, address, returnTo, me, onMe }: StreetDigestCardProps) {
  const t = useT();
  const session = useSession();
  const [pending, setPending] = useState<boolean | null>(null); // the optimistic value while the PUT is in flight
  const [error, setError] = useState(false);

  const line = address.trim().toLowerCase();
  const saved = me?.addresses.find((a) => (a.lat != null && a.lng != null && metersBetween(a.lat, a.lng, lat, lng) < SAME_PLACE_M) || (line !== '' && a.address.trim().toLowerCase() === line)) ?? null;
  const checked = pending ?? saved?.digest === true;

  async function toggle(on: boolean) {
    if (!me || pending !== null) return;
    setPending(on); setError(false);
    try {
      const name = (addressLabel(address) || t('street.digest.defaultLabel')).slice(0, 40);
      const r = saved ? await setAddressDigest(saved, on) : await saveAddress({ label: name, address: address.trim() || name, lat, lng, digest: true });
      onMe({ ...me, addresses: r.addresses });
      track(on ? 'street_digest_on' : 'street_digest_off', { from: 'street' });
    } catch { setError(true); } finally { setPending(null); }
  }

  return (
    <div className="card street-digest">
      {!session ? <Link to={`/account?returnTo=${encodeURIComponent(returnTo)}`} className="btn btn-secondary">{t('street.digest.signIn')}</Link> : (
        <div className="street-digest-row">
          <label className="switch-row">
            <span>{t('street.digest.switch')}</span>
            <input type="checkbox" role="switch" className="switch" checked={checked} disabled={!me} aria-busy={pending !== null || undefined}
              onChange={(e) => void toggle(e.target.checked)} />
          </label>
          <Link to="/account/updates" className="street-digest-manage">{t('street.digest.manage')}</Link>
        </div>
      )}
      {error && <p className="hint" role="alert">{t('street.digest.error')}</p>}
    </div>
  );
}
