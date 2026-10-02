import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../lib/auth';
import { myReports, type MyReportView } from '../api/me';
import type { ReportView } from '../api/types';
import { shortLabel } from '../lib/categories';
import { useT } from '../i18n';
import CategoryIcon from './CategoryIcon';
import Illustration from './Illustration';
import '../screens/Account.css';

/** The account's reports with a status pill each, so it reads like tracking. Signed out → sign-in prompt. */
export default function AccountReports() {
  const t = useT();
  const session = useSession();
  const [account, setAccount] = useState<MyReportView[] | null>(null);   // null = not loaded (or signed out)

  useEffect(() => {
    if (!session) { setAccount(null); return; }
    let live = true;
    myReports().then((r) => { if (live) setAccount(r.items); }).catch(() => { if (live) setAccount([]); });
    return () => { live = false; };
  }, [session]);

  const loading = !!session && account == null;
  if (!loading && (account ?? []).length === 0) {
    if (!session) {
      return (
        <div className="empty rise">
          <Illustration kind="empty" className="illo" />
          <p className="muted">{t('my.signedOut.prompt')}</p>
          <Link className="btn btn-primary" to="/account?returnTo=%2Fmy">{t('my.signedOut.cta')}</Link>
        </div>
      );
    }
    return (
      <div className="empty rise">
        <Illustration kind="empty" className="illo" />
        <h2>{t('empty.my.title')}</h2>
        <p className="muted">{t('my.empty')}</p>
        <Link className="btn btn-primary" to="/">{t('empty.my.cta')}</Link>
      </div>
    );
  }

  return (
    <div className="account-reports">
      {loading && <p className="muted" aria-busy="true">{t('account.loading')}</p>}
      {account && account.length > 0 && <ul className="my-list">{account.map((r) => <Row key={r.id} id={r.id} category={r.category} address={r.address} createdAt={r.createdAt} view={r} />)}</ul>}
    </div>
  );
}

function Row({ id, category, address, createdAt, view }: { id: string; category: string; address: string; createdAt: string; view: ReportView | null }) {
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
    case 'sent': return v.portalStatus === 'Resolved' ? 'resolved' : v.portalStatus === 'Cancelled' ? 'cityCancelled' : v.portalStatus === 'Merged' ? 'merged' : 'sent';
    case 'sending': case 'awaiting_review': return 'sending';
    case 'rejected': return v.cancelledByReporter ? 'cancelled' : 'notFiled';
    case 'failed': case 'needs_attention': return 'attention';
    default: return 'received';
  }
}
