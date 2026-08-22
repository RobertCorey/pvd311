import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../lib/auth';
import { cancelReport, editDescription, follow, unfollow, type MyReportView } from '../api/me';
import { ApiError } from '../api/types';
import { useT } from '../i18n';
import '../screens/Account.css';

/**
 * Signed-in actions on a tracked report:
 *   owner + still pending → edit description / cancel
 *   not the owner          → follow / unfollow (no email needed)
 * Renders nothing when signed out. `onChange` = re-fetch the report.
 */
export default function OwnerActions({ id, view, onChange }: { id: string; view: MyReportView; onChange: () => void }) {
  const t = useT();
  const session = useSession();
  const [desc, setDesc] = useState(view.description ?? '');
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<'saved' | 'cancelled' | 'locked' | 'error' | null>(null);
  const [followed, setFollowed] = useState(view.following === true);

  if (!session) return null;

  async function run(fn: () => Promise<unknown>, ok: 'saved' | 'cancelled' | null) {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg(ok); setEditing(false); setConfirm(false); onChange(); }
    catch (e) { setMsg(e instanceof ApiError && e.status === 409 ? 'locked' : 'error'); }
    finally { setBusy(false); }
  }

  if (view.mine) {
    if (!view.editable && !msg) return null; // sent / terminal — nothing to do
    return (
      <div className="section owner-actions">
        {view.editable && (
          <>
            <h2>{t('track.owner.edit')}</h2>
            {editing ? (
              <form className="card" onSubmit={(e) => { e.preventDefault(); run(() => editDescription(id, desc), 'saved'); }}>
                <label className="label" htmlFor="owner-desc">{t('track.owner.editLabel')}</label>
                <textarea id="owner-desc" className="textarea" rows={4} maxLength={2000} value={desc} onChange={(e) => setDesc(e.target.value)} />
                <div className="owner-row">
                  <button type="submit" className="btn btn-primary" disabled={busy}>{t('track.owner.save')}</button>
                  <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>{t('track.owner.cancelNo')}</button>
                </div>
              </form>
            ) : (
              <div className="owner-row">
                <button type="button" className="btn btn-secondary" onClick={() => { setDesc(view.description ?? ''); setEditing(true); }}>{t('track.owner.edit')}</button>
                {confirm ? (
                  <span className="owner-confirm" role="alertdialog" aria-label={t('track.owner.cancelConfirm')}>
                    <span>{t('track.owner.cancelConfirm')}</span>
                    <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run(() => cancelReport(id), 'cancelled')}>{t('track.owner.cancelYes')}</button>
                    <button type="button" className="btn btn-ghost" onClick={() => setConfirm(false)}>{t('track.owner.cancelNo')}</button>
                  </span>
                ) : (
                  <button type="button" className="btn btn-ghost" onClick={() => setConfirm(true)}>{t('track.owner.cancel')}</button>
                )}
              </div>
            )}
          </>
        )}
        {msg === 'saved' && <div className="notice notice-ok" role="status">{t('track.owner.saved')}</div>}
        {msg === 'cancelled' && <div className="notice notice-ok" role="status">{t('track.owner.cancelled')}</div>}
        {msg === 'locked' && <div className="notice notice-warn" role="status">{t('track.owner.locked')}</div>}
        {msg === 'error' && <div className="notice notice-error" role="alert">{t('track.owner.error')}</div>}
      </div>
    );
  }

  // Someone else's report: follow / unfollow with the account.
  return (
    <div className="section owner-actions">
      <h2>{t('track.follow.title')}</h2>
      <div className="owner-row">
        <button type="button" className={`btn ${followed ? 'btn-ghost' : 'btn-secondary'}`} disabled={busy}
          onClick={() => run(async () => { if (followed) { await unfollow(id); setFollowed(false); } else { await follow(id); setFollowed(true); } }, null)}>
          {followed ? t('track.unfollow') : t('track.follow.account')}
        </button>
        {followed && <span className="muted">{t('track.follow.accountDone')}</span>}
      </div>
      <p className="hint">{t('track.follow.consent')} <Link to="/account">{t('header.accountIn')}</Link></p>
      {msg === 'error' && <div className="notice notice-error" role="alert">{t('track.owner.error')}</div>}
    </div>
  );
}
