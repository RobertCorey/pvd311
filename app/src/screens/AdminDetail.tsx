import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useT } from '../i18n';
import { adminProofBlobUrl, adminProofs, adminTrust, adminUser, type AdminAction, type AdminProof, type AdminReport, type AdminUser } from '../api/admin';
import CategoryIcon from '../components/CategoryIcon';
import { ACTIONS } from './Admin';
import { When, abs } from './adminUtil';

/**
 * Right-hand detail pane for one queue row: photo, description (+ original), extra answers, flags, reporter,
 * review history, proof screenshots, and the actions — Approve · Reject (with a reason the reporter sees) ·
 * Requeue · Trust this account. `admin:reject` (the `r` key) focuses the reason box.
 */
export default function AdminDetail({ r, busy, onAct, onClose }: { r: AdminReport; busy: boolean; onAct: (a: AdminAction, reason?: string) => void; onClose: () => void }) {
  const t = useT();
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [proofs, setProofs] = useState<AdminProof[] | null>(null);
  const [proofUrls, setProofUrls] = useState<Record<string, string>>({});
  const [user, setUser] = useState<AdminUser | null>(null);
  const [trustBusy, setTrustBusy] = useState(false);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const actions = ACTIONS[r.status] ?? [];

  useEffect(() => {
    let live = true;
    adminProofs(r.id).then((p) => { if (live) setProofs(p); }).catch(() => { if (live) setProofs([]); });
    if (r.ownerUid) adminUser(r.ownerUid).then((u) => { if (live) setUser(u); }).catch(() => {});
    return () => { live = false; };
  }, [r.id, r.ownerUid]);

  // Proof thumbnails: authenticated fetch → object URLs, revoked on unmount.
  useEffect(() => {
    if (!proofs?.length) return;
    let live = true;
    const urls: string[] = [];
    Promise.all(proofs.slice(0, 6).map((p) => adminProofBlobUrl(r.id, p.name).then((u) => { urls.push(u); return [p.name, u] as const; }).catch(() => null)))
      .then((rows) => { if (live) setProofUrls(Object.fromEntries(rows.filter((x): x is readonly [string, string] => !!x))); });
    return () => { live = false; urls.forEach((u) => URL.revokeObjectURL(u)); };
  }, [proofs, r.id]);

  useEffect(() => {
    const open = () => setRejecting(true);
    document.addEventListener('admin:reject', open);
    return () => document.removeEventListener('admin:reject', open);
  }, []);
  useEffect(() => { if (rejecting) reasonRef.current?.focus(); }, [rejecting]);

  async function toggleTrust() {
    if (!user) return;
    setTrustBusy(true);
    try { setUser(await adminTrust(user.uid, !user.trusted)); } catch { /* toast is the queue's job; keep state */ } finally { setTrustBusy(false); }
  }

  return (
    <aside className="admin-pane" aria-label={t('admin.pane.title')}>
      <div className="admin-pane-head">
        <span className="admin-pane-cat"><CategoryIcon k={r.category} size={20} /> <strong>{r.categoryLabel}</strong></span>
        <span className="admin-status">{t(`admin.status.${r.status}`)}</span>
        <button type="button" className="btn btn-ghost admin-pane-close" onClick={onClose} aria-label={t('admin.pane.close')}>✕</button>
      </div>
      <div className="admin-pane-body">
        {r.photoUrl
          ? <a href={r.photoUrl} target="_blank" rel="noopener"><img className="admin-pane-photo" src={r.photoUrl} alt="" /></a>
          : <div className="admin-pane-nophoto">{t('admin.pane.noPhoto')}</div>}

        <dl className="admin-dl">
          <dt>{t('admin.col.address')}</dt><dd>{r.address}{r.lat != null && r.lng != null && <span className="admin-meta"> · {r.lat.toFixed(5)}, {r.lng.toFixed(5)}</span>}</dd>
          <dt>{t('admin.pane.filed')}</dt><dd><When iso={r.createdAt} t={t} /> <span className="admin-meta">{abs(r.createdAt)}</span> · <Link to={`/r/${r.id}`} target="_blank">{r.id}</Link></dd>
          {r.portalCaseId && <><dt>{t('admin.pane.case')}</dt><dd>{r.portalCaseId}{r.portalStatus ? ` · ${r.portalStatus}` : ''}</dd></>}
          <dt>{t('admin.col.reporter')}</dt>
          <dd>
            {r.reporterEmail ?? <span className="admin-meta">{t('admin.noEmail')}</span>}
            {user && <div className="admin-meta">{t('admin.pane.history', { sent: user.submitted, rejected: user.rejected })}{user.trusted ? ` · ${t('admin.pane.trusted')}` : ''}</div>}
          </dd>
          {r.intakeFlags.length > 0 && <><dt>{t('admin.col.flags')}</dt><dd className="admin-flags">{r.intakeFlags.map((f) => <span key={f} className="admin-flag">{f}</span>)}</dd></>}
        </dl>

        <h3 className="label">{t('admin.pane.description')}</h3>
        {r.description ? <p className="admin-desc">{r.description}</p> : <p className="admin-orig">{t('admin.noDescription')}</p>}
        {r.descriptionOriginal && r.descriptionOriginal !== r.description && <p className="admin-orig"><span className="label">{t('admin.original')}</span>{r.descriptionOriginal}</p>}
        {r.extra && Object.keys(r.extra).length > 0 && (
          <dl className="admin-dl admin-dl--extra">{Object.entries(r.extra).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
        )}

        {(r.statusDetail || r.review || r.retries > 0) && (
          <>
            <h3 className="label">{t('admin.pane.review')}</h3>
            <ul className="admin-history">
              {r.statusDetail && <li>{r.statusDetail} <span className="admin-meta">{abs(r.statusUpdatedAt)}</span></li>}
              {r.review?.requestedAt && <li>{t('admin.pane.reviewRequested')} <span className="admin-meta">{abs(r.review.requestedAt)}</span></li>}
              {r.review?.decision && <li>{t(`admin.pane.decision.${r.review.decision}`)} {r.review.by ? `— ${r.review.by}` : ''} <span className="admin-meta">{abs(r.review.decidedAt)}</span></li>}
              {r.retries > 0 && <li>{t('admin.retries', { n: r.retries })}{r.retryAfter ? ` · ${abs(r.retryAfter)}` : ''}</li>}
            </ul>
          </>
        )}

        <h3 className="label">{t('admin.pane.proofs')}</h3>
        {proofs == null ? <p className="admin-meta">{t('account.loading')}</p> : proofs.length === 0 ? <p className="admin-meta">{t('admin.pane.noProofs')}</p> : (
          <div className="admin-proofs">
            {proofs.map((p) => proofUrls[p.name]
              ? <a key={p.name} href={proofUrls[p.name]} target="_blank" rel="noopener" title={`${p.name} · ${abs(p.createdAt)}`}><img src={proofUrls[p.name]} alt={p.name} /></a>
              : <span key={p.name} className="admin-proof-ph" title={p.name} />)}
          </div>
        )}
      </div>

      <div className="admin-pane-actions">
        {actions.includes('approve') && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onAct('approve')}>{t('admin.action.approve')} <kbd>a</kbd></button>}
        {actions.includes('requeue') && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => onAct('requeue')}>{t('admin.action.requeue')}</button>}
        {actions.includes('reject') && !rejecting && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setRejecting(true)}>{t('admin.action.reject')} <kbd>r</kbd></button>}
        {user && <button type="button" className="btn btn-ghost" disabled={trustBusy} onClick={toggleTrust} aria-pressed={user.trusted}>{user.trusted ? t('admin.pane.untrust') : t('admin.pane.trust')}</button>}
        {rejecting && (
          <div className="admin-reject">
            <label className="label" htmlFor="admin-reason">{t('admin.pane.reason')}</label>
            <textarea id="admin-reason" ref={reasonRef} className="textarea" rows={2} maxLength={300} value={reason} placeholder={t('admin.pane.reasonPlaceholder')} onChange={(e) => setReason(e.target.value)} />
            <div className="admin-reject-row">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onAct('reject', reason.trim() || undefined)}>{t('admin.pane.rejectConfirm')}</button>
              <button type="button" className="btn btn-ghost" onClick={() => setRejecting(false)}>{t('track.owner.cancelNo')}</button>
            </div>
            <p className="hint">{t('admin.pane.reasonHint')}</p>
          </div>
        )}
      </div>
    </aside>
  );
}
