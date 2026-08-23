import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../lib/auth';
import { claimAndRecover, myReports, type MyReportView } from '../api/me';
import { getReport } from '../api/client';
import type { ReportView } from '../api/types';
import { listMyReports, type MyReport } from '../lib/myReports';
import { shortLabel } from '../lib/categories';
import { useT } from '../i18n';
import CategoryIcon from './CategoryIcon';
import Illustration from './Illustration';
import '../screens/Account.css';

/**
 * The whole "My reports" list: the account's reports (signed in) + this device's (tracking ids kept in
 * localStorage), each with a status pill so it reads like tracking. Device rows the account doesn't own yet get a
 * one-tap "attach" button. The empty state shows only when BOTH lists are empty.
 */
export default function AccountReports() {
  const t = useT();
  const session = useSession();
  const local = listMyReports();
  const [account, setAccount] = useState<MyReportView[] | null>(null);   // null = not loaded (or signed out)
  const [localStatus, setLocalStatus] = useState<Record<string, ReportView>>({});
  const [claimed, setClaimed] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!session) { setAccount(null); return; }
    let live = true;
    myReports().then((r) => { if (live) setAccount(r.items); }).catch(() => { if (live) setAccount([]); });
    return () => { live = false; };
  }, [session, claimed]);

  // Status for device rows not covered by the account list (public tracking read, ≤20 newest).
  const owned = new Set((account ?? []).map((r) => r.id));
  const deviceOnly = local.filter((r) => !owned.has(r.id));
  const needIds = deviceOnly.slice(0, 20).map((r) => r.id).filter((id) => !localStatus[id]).join(',');
  useEffect(() => {
    if (!needIds) return;
    let live = true;
    Promise.all(needIds.split(',').map((id) => getReport(id).then((v) => [id, v] as const).catch(() => null)))
      .then((rows) => { if (live) setLocalStatus((m) => ({ ...m, ...Object.fromEntries(rows.filter((x): x is readonly [string, ReportView] => !!x)) })); });
    return () => { live = false; };
  }, [needIds]);

  async function claim() {
    setBusy(true);
    try { setClaimed(await claimAndRecover(deviceOnly.map((r) => r.id))); } finally { setBusy(false); }
  }

  const loading = !!session && account == null;
  if (!loading && (account ?? []).length === 0 && local.length === 0) {
    return (
      <div className="empty rise">
        <Illustration kind="empty" className="illo" />
        <h2>{t('empty.my.title')}</h2>
        <p className="muted">{t('my.empty')}</p>
        <Link className="btn btn-primary" to="/">{t('empty.my.cta')}</Link>
        {!session && <p className="hint"><Link to="/account">{t('my.signIn')}</Link></p>}
      </div>
    );
  }

  return (
    <div className="account-reports">
      {!session && local.length > 0 && <p className="hint"><Link to="/account">{t('my.signIn')}</Link></p>}
      {session && deviceOnly.length > 0 && claimed == null && account != null && (
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={claim}>{t('my.claim')}</button>
      )}
      {claimed != null && <div className="notice notice-ok" role="status">{t('my.claimed', { n: claimed })}</div>}
      {loading && <p className="muted" aria-busy="true">{t('account.loading')}</p>}
      {account && account.length > 0 && (
        <>
          {deviceOnly.length > 0 && <h3 className="label">{t('my.account')}</h3>}
          <ul className="my-list">{account.map((r) => <Row key={r.id} id={r.id} category={r.category} address={r.address} createdAt={r.createdAt} view={r} />)}</ul>
        </>
      )}
      {deviceOnly.length > 0 && (
        <>
          {account && account.length > 0 && <h3 className="label">{t('my.device')}</h3>}
          <ul className="my-list">{deviceOnly.map((r) => <Row key={r.id} id={r.id} category={r.category} address={r.address} createdAt={r.createdAt} view={localStatus[r.id] ?? null} />)}</ul>
        </>
      )}
    </div>
  );
}

function Row({ id, category, address, createdAt, view }: Pick<MyReport, 'id' | 'category' | 'address' | 'createdAt'> & { view: ReportView | null }) {
  const t = useT();
  return (
    <li><Link to={`/r/${id}`} className="card my-row rise">
      <span className="my-icon" aria-hidden="true"><CategoryIcon k={category} size={36} /></span>
      <span className="my-cat">{shortLabel(category, t)}</span>
      <span className="my-addr">{address}</span>
      <span className="muted my-date">{createdAt ? new Date(createdAt).toLocaleDateString() : ''}</span>
      <span className="my-status-slot">{view && <StatusPill view={view} />}</span>
    </Link></li>
  );
}

/** Short tracking status: Received · Sending · Sent · Resolved · Cancelled · Not filed · Needs attention. */
export function StatusPill({ view }: { view: ReportView }) {
  const t = useT();
  const k = pillKey(view);
  return <span className={`my-status my-status--${k}`}>{t(`my.status.${k}`)}</span>;
}
function pillKey(v: ReportView): string {
  switch (v.status) {
    case 'sent': return v.portalStatus === 'Resolved' ? 'resolved' : v.portalStatus === 'Cancelled' ? 'cityCancelled' : 'sent';
    case 'sending': case 'awaiting_review': return 'sending';
    case 'rejected': return v.cancelledByReporter ? 'cancelled' : 'notFiled';
    case 'failed': case 'needs_attention': return 'attention';
    default: return 'received';
  }
}
