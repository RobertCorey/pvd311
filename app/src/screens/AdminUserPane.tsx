import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { adminProfile, adminTrust, type AdminProfile } from '../api/admin';
import CategoryIcon from '../components/CategoryIcon';
import { When, abs } from './adminUtil';
import { EmailRows } from './AdminEmailParts';

/**
 * One person (`#accounts:<uid>`): the account, every report they filed (→ the report in Reports) and every email to or
 * from their address (→ the mail in Email). The user-centred way into the same system.
 */
export default function AdminUserPane({ uid, onClose }: { uid: string; onClose: () => void }) {
  const t = useT();
  const [p, setP] = useState<AdminProfile | null>(null);
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    setP(null); setErr(false);
    adminProfile(uid).then((x) => { if (live) setP(x); }).catch(() => { if (live) setErr(true); });
    return () => { live = false; };
  }, [uid]);

  async function toggleTrust() {
    if (!p) return;
    setBusy(true);
    try { const u = await adminTrust(p.user.uid, !p.user.trusted); setP({ ...p, user: { ...p.user, trusted: u.trusted } }); } catch { /* the row keeps its state */ } finally { setBusy(false); }
  }

  const u = p?.user;
  return (
    <aside className="admin-pane user-pane" aria-label={t('admin.user.pane')}>
      <div className="admin-pane-head">
        <strong className="admin-ellipsis">{u?.email ?? (err ? '' : t('account.loading'))}</strong>
        <button type="button" className="btn btn-ghost admin-pane-close" onClick={onClose} aria-label={t('admin.pane.close')}>✕</button>
      </div>
      <div className="admin-pane-body">
        {err && <div className="notice notice-error" role="alert">{t('admin.loadError')}</div>}
        {u && p && (
          <>
            <dl className="admin-dl">
              {u.displayName && <><dt>{t('admin.user.name')}</dt><dd>{u.displayName}</dd></>}
              <dt>{t('admin.accounts.col.provider')}</dt><dd><span className="sys-kind">{u.provider}</span>{u.emailVerified ? '' : ` · ${t('admin.user.unverified')}`}</dd>
              <dt>{t('admin.accounts.col.created')}</dt><dd><When iso={u.createdAt} t={t} /> <span className="admin-meta">{abs(u.createdAt)}</span></dd>
              <dt>{t('admin.accounts.col.lastSeen')}</dt><dd><When iso={u.lastSeenAt} t={t} /></dd>
              <dt>{t('admin.user.filing')}</dt>
              <dd>{t('admin.pane.history', { sent: u.submitted, rejected: u.rejected })} · {u.autoFiles ? t('admin.user.autoFiles') : t('admin.user.reviewed')}</dd>
              <dt>{t('admin.accounts.col.emailUpdates')}</dt><dd>{u.emailUpdates ? t('admin.accounts.on') : t('admin.accounts.off')}</dd>
              <dt>{t('admin.user.followingSaved')}</dt><dd>{t('admin.user.followingSavedV', { f: u.following.length, a: u.addresses })}</dd>
              <dt>uid</dt><dd className="acct-id">{u.uid}</dd>
            </dl>
            <div className="owner-row">
              <button type="button" className="chip acct-trust" aria-pressed={u.trusted} disabled={busy} title={t('admin.accounts.trustHint')} onClick={toggleTrust}>
                {u.trusted ? t('admin.accounts.trusted') : t('admin.accounts.trust')}
              </button>
            </div>

            <h3 className="label">{t('admin.user.reports', { n: p.reports.length })}</h3>
            {p.reports.length === 0 ? <p className="admin-meta">{t('admin.user.noReports')}</p> : (
              <ul className="email-rows">
                {p.reports.map((r) => (
                  <li key={r.id}>
                    <a className="email-row" href={`#reports?q=${encodeURIComponent(r.id)}`}>
                      <span className="email-row-top">
                        <CategoryIcon k={r.category} size={16} />
                        <strong>{r.categoryLabel}</strong>
                        <span className="email-row-when"><When iso={r.createdAt} t={t} /></span>
                        <span className="admin-meta">{t(`admin.status.${r.status}`)}{r.portalStatus ? ` · ${r.portalStatus}` : ''}</span>
                      </span>
                      <span className="email-row-subject">{r.address}{r.portalCaseId ? <span className="admin-meta"> · {r.portalCaseId}</span> : null}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}

            <h3 className="label">{t('admin.user.emails', { n: p.emails.length })}</h3>
            <EmailRows items={p.emails} t={t} />
          </>
        )}
      </div>
    </aside>
  );
}
