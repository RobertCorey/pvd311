import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { useSession } from '../lib/auth';
import { getMe } from '../api/me';
import type { Quota } from '../api/types';
import AccountReports from '../components/AccountReports';

/** Account reports + this device's reports, with status pills, claim, and the empty state — all in AccountReports.
 *  Signed in: the weekly reporter quota line ("This week: N of 15", docs/quota.md). */
export default function MyReports() {
  const t = useT();
  const session = useSession();
  const [quota, setQuota] = useState<Quota | null>(null);
  useEffect(() => {
    if (!session) { setQuota(null); return; }
    let live = true;
    getMe().then((m) => { if (live) setQuota(m.quota ?? null); }).catch(() => { /* offline: no line */ });
    return () => { live = false; };
  }, [session]);
  return (
    <section className="section">
      <h1>{t('header.myReports')}</h1>
      {quota && <p className="muted quota-week">{t('my.quota.week', { used: quota.weekUsed, limit: quota.weekLimit })}</p>}
      <AccountReports />
    </section>
  );
}
