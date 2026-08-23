import { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from '../i18n';
import { adminTrust, adminUsers, type AdminAccount } from '../api/admin';
import { Dot, When } from './adminUtil';
import './Admin.css';
import './AdminAccounts.css';

type Tr = ReturnType<typeof useT>;
const PAGE = 50;

/**
 * /admin → Accounts: every person who has ever signed in, densest-possible table.
 * Server pages by `lastSeenAt` cursor (Load more → `next` as `before`); sort + filter are client-side.
 * A row click deep-links into the Reports tab filtered to that account (`#reports?q=<email|uid>`).
 * Trust is a per-row optimistic toggle — flips locally, reverts on error.
 */
export default function AdminAccounts() {
  const t = useT();
  const [items, setItems] = useState<AdminAccount[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState(false);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);

  const say = useCallback((msg: string) => { setToast(msg); window.setTimeout(() => setToast(null), 3500); }, []);

  const load = useCallback(async (before: string | null) => {
    setLoading(true); setErr(false);
    try {
      const page = await adminUsers(before, PAGE);
      setItems((prev) => (before ? [...prev, ...page.items] : page.items));
      setNext(page.next);
      setLoaded(true);
    } catch { setErr(true); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(null); }, [load]);

  const toggleTrust = useCallback(async (u: AdminAccount) => {
    const target = !u.trusted;
    setBusy((b) => new Set(b).add(u.uid));
    setItems((prev) => prev.map((x) => (x.uid === u.uid ? { ...x, trusted: target } : x))); // optimistic
    try {
      await adminTrust(u.uid, target);
    } catch {
      setItems((prev) => prev.map((x) => (x.uid === u.uid ? { ...x, trusted: u.trusted } : x))); // revert
      say(t('admin.error'));
    } finally {
      setBusy((b) => { const n = new Set(b); n.delete(u.uid); return n; });
    }
  }, [say, t]);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const seen = (u: AdminAccount) => Date.parse(u.lastSeenAt ?? '') || 0;
    return items
      .filter((u) => !q || [u.email, u.displayName, u.uid].some((v) => v?.toLowerCase().includes(q)))
      .sort((a, b) => seen(b) - seen(a));
  }, [items, filter]);

  const totals = useMemo(() => ({
    n: items.length,
    trusted: items.filter((u) => u.trusted).length,
    auto: items.filter((u) => u.autoFiles).length,
  }), [items]);

  const openReports = (u: AdminAccount) => { location.hash = '#reports?q=' + encodeURIComponent(u.email || u.uid); };

  if (!loaded) {
    return err
      ? <div className="notice notice-error" role="alert">{t('admin.loadError')} <button type="button" className="btn btn-ghost" onClick={() => load(null)}>{t('account.retry')}</button></div>
      : <p className="muted" aria-busy="true">{t('account.loading')}</p>;
  }

  return (
    <div className="admin-accounts">
      <p className="portal-intro">{t('admin.accounts.intro')}</p>
      {err && <div className="notice notice-error" role="alert">{t('admin.loadError')} <button type="button" className="btn btn-ghost" onClick={() => load(null)}>{t('account.retry')}</button></div>}

      <div className="acct-toolbar">
        <label className="acct-filter">
          <span className="visually-hidden">{t('admin.accounts.filter')}</span>
          <input className="input" type="search" placeholder={t('admin.accounts.filterPlaceholder')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
        <span className="acct-totals">
          {t('admin.accounts.totals', { n: totals.n, trusted: totals.trusted, auto: totals.auto })}
          {filter.trim() && <> · {t('admin.accounts.filterResults', { n: rows.length })}</>}
        </span>
        <button type="button" className="btn btn-ghost admin-refresh" onClick={() => load(null)} disabled={loading}>{t('admin.refresh')}</button>
      </div>

      {rows.length === 0 ? (
        <p className="admin-empty">{filter.trim() ? t('admin.accounts.noneMatch') : t('admin.accounts.empty')}</p>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table acct-table">
            <thead>
              <tr>
                <th scope="col">{t('admin.accounts.col.email')}</th>
                <th scope="col">{t('admin.accounts.col.provider')}</th>
                <th scope="col">{t('admin.accounts.col.verified')}</th>
                <th scope="col">{t('admin.accounts.col.created')}</th>
                <th scope="col">{t('admin.accounts.col.lastSeen')}</th>
                <th scope="col" className="acct-num">{t('admin.accounts.col.submitted')}</th>
                <th scope="col" className="acct-num">{t('admin.accounts.col.rejected')}</th>
                <th scope="col" className="acct-num">{t('admin.accounts.col.awaiting')}</th>
                <th scope="col">{t('admin.accounts.col.autoFiles')}</th>
                <th scope="col">{t('admin.accounts.col.trusted')}</th>
                <th scope="col">{t('admin.accounts.col.emailUpdates')}</th>
                <th scope="col" className="acct-num">{t('admin.accounts.col.following')}</th>
                <th scope="col" className="acct-num">{t('admin.accounts.col.addresses')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.uid} tabIndex={0} onClick={() => openReports(u)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'o') openReports(u); }}>
                  <td className="acct-email">
                    <div className="admin-ellipsis">{u.email ?? <span className="admin-meta">{t('admin.noEmail')}</span>}</div>
                    {u.displayName && <div className="admin-meta admin-ellipsis">{u.displayName}</div>}
                    <div className="acct-id admin-ellipsis" title={u.uid}>{u.uid}</div>
                  </td>
                  <td><span className="sys-kind">{u.provider}</span></td>
                  <td><YesNo v={u.emailVerified} t={t} /></td>
                  <td><When iso={u.createdAt} t={t} /></td>
                  <td><When iso={u.lastSeenAt} t={t} /></td>
                  <td className="acct-num">{u.submitted}</td>
                  <td className="acct-num">{u.rejected}</td>
                  <td className="acct-num">{u.awaitingReview}</td>
                  <td><YesNo v={u.autoFiles} t={t} /></td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <button type="button" className="chip acct-trust" aria-pressed={u.trusted} disabled={busy.has(u.uid)}
                      title={t('admin.accounts.trustHint')} onClick={() => void toggleTrust(u)}>
                      {u.trusted ? t('admin.accounts.trusted') : t('admin.accounts.trust')}
                    </button>
                  </td>
                  <td className="acct-yn">{u.emailUpdates ? t('admin.accounts.on') : t('admin.accounts.off')}</td>
                  <td className="acct-num">{u.following}</td>
                  <td className="acct-num">{u.addresses}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="acct-more">
        {next
          ? <button type="button" className="btn btn-secondary" onClick={() => load(next)} disabled={loading}>{loading ? t('account.loading') : t('admin.accounts.loadMore')}</button>
          : loaded && items.length > 0 && <span className="acct-totals">{t('admin.accounts.end')}</span>}
      </div>

      {toast && <div className="notice notice-error admin-toast" role="status">{toast}</div>}
    </div>
  );
}

const YesNo = ({ v, t }: { v: boolean; t: Tr }) => (
  <span className="acct-yn"><Dot status={v ? 'ok' : 'unknown'} /> {v ? t('admin.accounts.yes') : t('admin.accounts.no')}</span>
);
