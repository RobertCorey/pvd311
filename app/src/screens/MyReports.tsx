import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { useSession } from '../lib/auth';
import { getMe, type Me } from '../api/me';
import AccountReports from '../components/AccountReports';
import FollowedCases from '../components/FollowedCases';
import type { FollowEmailState } from '../components/StreetFollow';

/** Account reports + this device's reports, with status pills, claim, and the empty state — all in AccountReports.
 *  Signed in: the weekly reporter quota line ("This week: N of 15", docs/quota.md), then the city cases the account
 *  follows from /street (FollowedCases; only when there are any). An account that follows cases but has reported
 *  nothing (the "check in on it" visitor) gets the followed list FIRST and the reports' empty state trimmed to its
 *  prompt + CTA under it — never a "Nothing here yet" headline over a list. Keyed children, so the swap reorders
 *  without remounting (no second /api/me/city). */
export default function MyReports() {
  const t = useT();
  const session = useSession();
  const [me, setMe] = useState<Me | null>(null);
  const [reports, setReports] = useState<number | null>(null);
  const [followed, setFollowed] = useState<number | null>(null);
  useEffect(() => {
    if (!session) { setMe(null); setReports(null); setFollowed(null); return; }
    let live = true;
    getMe().then((m) => { if (live) setMe(m); }).catch(() => { /* offline: no line */ });
    return () => { live = false; };
  }, [session]);
  const quota = me?.quota ?? null;
  const email: FollowEmailState | undefined = me ? (me.prefs.emailUpdates === false ? 'off' : !me.emailVerified ? 'unverified' : 'ok') : undefined;
  const followedFirst = reports === 0 && (followed ?? 0) > 0;
  const parts = [
    <AccountReports key="reports" compact={followedFirst} onLoaded={setReports} />,
    <FollowedCases key="followed" email={email} onLoaded={setFollowed} />,
  ];
  return (
    <section className="section">
      <h1>{t('header.myReports')}</h1>
      {quota && <p className="muted quota-week">{t('my.quota.week', { used: quota.weekUsed, limit: quota.weekLimit })}</p>}
      {followedFirst ? parts.reverse() : parts}
    </section>
  );
}
