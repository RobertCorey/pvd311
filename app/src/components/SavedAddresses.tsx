import { useEffect, useState } from 'react';
import { useSession } from '../lib/auth';
import { getMe, type SavedAddress } from '../api/me';
import { forwardGeocode } from '../lib/geo';
import { useT } from '../i18n';
import '../screens/Account.css';

export interface PickedAddress { address: string; lat: number | null; lng: number | null }

/** Chips of the account's saved addresses (nothing when signed out or none saved). Geocodes on pick when no coords are stored. */
export default function SavedAddresses({ onPick }: { onPick: (a: PickedAddress) => void }) {
  const t = useT();
  const session = useSession();
  const [items, setItems] = useState<SavedAddress[]>([]);
  useEffect(() => {
    if (!session) { setItems([]); return; }
    let live = true;
    getMe().then((m) => { if (live) setItems(m.addresses); }).catch(() => { /* offline or signed out */ });
    return () => { live = false; };
  }, [session]);
  if (!session || items.length === 0) return null;
  async function pick(a: SavedAddress) {
    if (a.lat != null && a.lng != null) { onPick({ address: a.address, lat: a.lat, lng: a.lng }); return; }
    try { const hit = await forwardGeocode(a.address); onPick({ address: a.address, lat: hit?.lat ?? null, lng: hit?.lng ?? null }); }
    catch { onPick({ address: a.address, lat: null, lng: null }); }
  }
  return (
    <div className="saved-addresses" role="group" aria-label={t('account.addresses.title')}>
      {items.map((a) => (
        <button key={a.id} type="button" className="chip" onClick={() => pick(a)} title={a.address}>{a.label}</button>
      ))}
    </div>
  );
}
