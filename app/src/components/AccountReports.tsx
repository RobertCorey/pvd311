import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../lib/auth';
import { claimReports, myReports, type MyReportView } from '../api/me';
import { listMyReports } from '../lib/myReports';
import { shortLabel } from '../lib/categories';
import { useT } from '../i18n';
import '../screens/Account.css';

/**
 * My reports, account half: signed out → a one-line sign-in nudge; signed in → the account's reports from
 * other devices (ids already in this device's list are skipped) + a "claim" button for local reports the
 * account doesn't own yet. Drop in above the device list.
 */
export default function AccountReports() {
  const t = useT();
  const session = useSession();
  const [items, setItems] = useState<MyReportView[] | null>(null);
  const [claimed, setClaimed] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const local = listMyReports();

  useEffect(() => {
    if (!session) { setItems(null); return; }
    let live = true;
    myReports().then((r) => { if (live) setItems(r.items); }).catch(() => { if (live) setItems([]); });
    return () => { live = false; };
  }, [session, claimed]);

  if (!session) {
    return local.length > 0 ? <p className="hint"><Link to="/account">{t('my.signIn')}</Link></p> : null;
  }
  const owned = new Set((items ?? []).map((r) => r.id));
  const unclaimed = local.filter((r) => !owned.has(r.id));
  const remote = (items ?? []).filter((r) => !local.some((l) => l.id === r.id));

  async function claim() {
    setBusy(true);
    try { setClaimed((await claimReports(unclaimed.map((r) => r.id))).claimed.length); } catch { setClaimed(0); } finally { setBusy(false); }
  }

  return (
    <div className="account-reports">
      {items != null && unclaimed.length > 0 && claimed == null && (
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={claim}>{t('my.claim')}</button>
      )}
      {claimed != null && <div className="notice notice-ok" role="status">{t('my.claimed', { n: claimed })}</div>}
      {remote.length > 0 && (
        <>
          <h3 className="label">{t('my.account')}</h3>
          <ul className="my-list">
            {remote.map((r) => (
              <li key={r.id}><Link to={`/r/${r.id}`} className="card my-row">
                <span className="my-cat">{shortLabel(r.category, t)}</span>
                <span className="my-addr">{r.address}</span>
                <span className="muted my-date">{r.createdAt ? new Date(r.createdAt).toLocaleDateString() : ''}</span>
              </Link></li>
            ))}
          </ul>
          {local.length > 0 && <h3 className="label">{t('my.device')}</h3>}
        </>
      )}
    </div>
  );
}
