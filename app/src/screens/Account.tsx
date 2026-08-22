import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useT } from '../i18n';
import { shortLabel } from '../lib/categories';
import { listMyReports } from '../lib/myReports';
import {
  AuthError, GOOGLE_CLIENT_ID, completeSignInLink, isSignInLink, loadGsi, pendingEmail, sendSignInLink,
  signInWithGoogleCredential, signOut, takeReturnTo, useSession,
} from '../lib/auth';
import { claimReports, deleteAddress, followingReports, getMe, recoverReports, saveAddress, updateMe, type Me, type MyReportView } from '../api/me';
import './Account.css';

type Phase = 'idle' | 'busy' | 'sent' | 'error';

export default function Account() {
  const session = useSession();
  const navigate = useNavigate();
  // Already signed in and asked to come back somewhere (e.g. a parked report) → go there.
  const returnTo = new URLSearchParams(location.search).get('returnTo');
  useEffect(() => { if (session && returnTo && !isSignInLink()) navigate(takeReturnTo('/my'), { replace: true }); }, [session, returnTo, navigate]);
  return <section className="section account">{session ? <SignedIn /> : <SignedOut />}</section>;
}

// ── Signed out: email link + Google ──
function SignedOut() {
  const t = useT();
  const navigate = useNavigate();
  const [email, setEmail] = useState(pendingEmail() ?? '');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const finishing = isSignInLink();
  const [needEmail, setNeedEmail] = useState(false);
  const gBtn = useRef<HTMLDivElement>(null);

  const afterSignIn = useCallback(async () => {
    // Attach this device's anonymous reports + anything filed with this email, then land on My reports.
    const ids = listMyReports().map((r) => r.id);
    let n = 0;
    try { if (ids.length) n += (await claimReports(ids)).claimed.length; } catch { /* best effort */ }
    try { n += (await recoverReports()).claimed.length; } catch { /* unverified email or offline */ }
    navigate(takeReturnTo('/my'), { replace: true, state: { claimed: n } });
  }, [navigate]);

  // Complete an email link when we land on /account?mode=signIn&oobCode=…
  useEffect(() => {
    if (!finishing) return;
    const e = pendingEmail();
    if (!e) { setNeedEmail(true); return; }
    setPhase('busy');
    completeSignInLink(e).then(afterSignIn).catch((err: unknown) => { setPhase('error'); setError(errKey(err)); });
  }, [finishing, afterSignIn]);

  // Google button (GIS) — renders only when a client id is configured and the script loads.
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID || finishing) return;
    let cancelled = false;
    loadGsi().then((g) => {
      if (cancelled || !gBtn.current) return;
      g.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID, ux_mode: 'popup', itp_support: true,
        callback: (r: { credential?: string }) => {
          if (!r.credential) return;
          setPhase('busy');
          signInWithGoogleCredential(r.credential).then(afterSignIn).catch((err: unknown) => { setPhase('error'); setError(errKey(err)); });
        },
      });
      g.accounts.id.renderButton(gBtn.current, { type: 'standard', theme: 'outline', size: 'large', shape: 'pill', width: 280, text: 'continue_with', logo_alignment: 'left' });
    }).catch(() => { /* no Google button; email link still works */ });
    return () => { cancelled = true; };
  }, [finishing, afterSignIn]);

  async function onSend(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setPhase('busy'); setError(null);
    try {
      if (finishing && needEmail) { await completeSignInLink(email); await afterSignIn(); return; }
      await sendSignInLink(email, takeReturnTo('/my')); setPhase('sent');
    } catch (err) { setPhase('error'); setError(errKey(err)); }
  }

  if (finishing && !needEmail && phase !== 'error') {
    return <p className="muted" aria-live="polite" aria-busy="true">{t('account.finishing')}</p>;
  }

  return (
    <>
      <h1 className="account-h1">{t('account.title')}</h1>
      <p className="muted">{t('account.why')}</p>
      <ul className="account-perks">
        <li>{t('account.perk.devices')}</li>
        <li>{t('account.perk.follow')}</li>
        <li>{t('account.perk.edit')}</li>
        <li>{t('account.perk.addresses')}</li>
      </ul>

      {phase === 'sent' ? (
        <div className="notice notice-ok" role="status">
          <strong>{t('account.sent.title')}</strong>
          <p>{t('account.sent.body', { email })}</p>
          <button type="button" className="btn btn-ghost" onClick={() => setPhase('idle')}>{t('account.sent.again')}</button>
        </div>
      ) : (
        <form className="card account-form" onSubmit={onSend} noValidate>
          <label className="label" htmlFor="account-email">{needEmail ? t('account.confirmEmail.label') : t('account.email.label')}</label>
          {needEmail && <p className="hint">{t('account.confirmEmail.hint')}</p>}
          <input id="account-email" className="input" type="email" inputMode="email" autoComplete="email" placeholder={t('account.email.placeholder')}
            value={email} onChange={(e) => setEmail(e.target.value)} required />
          <button type="submit" className="btn btn-primary" disabled={!email.trim() || phase === 'busy'}>
            {phase === 'busy' ? t('account.email.sending') : needEmail ? t('account.confirmEmail.submit') : t('account.email.submit')}
          </button>
          <p className="hint">{t('account.email.hint')}</p>
          {error && <div className="notice notice-error" role="alert">{t(`account.error.${error}`)}</div>}
        </form>
      )}

      {GOOGLE_CLIENT_ID && !finishing && (
        <div className="account-or">
          <span className="muted">{t('account.or')}</span>
          <div ref={gBtn} className="account-google" aria-label={t('account.google')} />
        </div>
      )}
      <p className="hint account-optional">{t('account.optional')} <Link to="/map">{t('account.reportAnon')}</Link></p>
    </>
  );
}

// ── Signed in: profile, prefs, addresses, following ──
function SignedIn() {
  const t = useT();
  const navigate = useNavigate();
  const [me, setMe] = useState<Me | null>(null);
  const [following, setFollowing] = useState<MyReportView[] | null>(null);
  const [err, setErr] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [recovered, setRecovered] = useState<number | null>(null);
  const [addr, setAddr] = useState({ label: '', address: '' });

  const load = useCallback(async () => {
    try {
      const m = await getMe(); setMe(m); setName(m.displayName ?? ''); setErr(false);
      followingReports().then((r) => setFollowing(r.items)).catch(() => setFollowing([]));
    } catch (e) {
      if (e instanceof Error && (e as { status?: number }).status === 401) { signOut(); return; }
      setErr(true);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function saveName(e: React.FormEvent) {
    e.preventDefault(); setSaving(true);
    try { setMe(await updateMe({ displayName: name.trim() || null })); } catch { setErr(true); } finally { setSaving(false); }
  }
  async function togglePref(v: boolean) {
    if (!me) return;
    setMe({ ...me, prefs: { emailUpdates: v } });
    try { setMe(await updateMe({ prefs: { emailUpdates: v } })); } catch { setErr(true); }
  }
  async function addAddress(e: React.FormEvent) {
    e.preventDefault();
    if (addr.address.trim().length < 3) return;
    setSaving(true);
    try { const r = await saveAddress({ label: addr.label.trim(), address: addr.address.trim() }); setMe((m) => (m ? { ...m, addresses: r.addresses } : m)); setAddr({ label: '', address: '' }); }
    catch { setErr(true); } finally { setSaving(false); }
  }
  async function removeAddress(id: string) {
    try { const r = await deleteAddress(id); setMe((m) => (m ? { ...m, addresses: r.addresses } : m)); } catch { setErr(true); }
  }
  async function recover() {
    setSaving(true);
    try {
      const ids = listMyReports().map((r) => r.id);
      let n = 0;
      if (ids.length) n += (await claimReports(ids)).claimed.length;
      n += (await recoverReports()).claimed.length;
      setRecovered(n);
    } catch { setRecovered(0); } finally { setSaving(false); }
  }

  if (!me) {
    return err
      ? <div className="notice notice-error" role="alert">{t('account.error.load')} <button type="button" className="btn btn-ghost" onClick={load}>{t('account.retry')}</button></div>
      : <p className="muted" aria-busy="true">{t('account.loading')}</p>;
  }

  return (
    <>
      <h1 className="account-h1">{t('account.signedIn.title')}</h1>
      <p className="muted account-email">{me.email ?? '—'}</p>
      {err && <div className="notice notice-error" role="alert">{t('account.error.save')}</div>}

      <div className="account-actions">
        <Link className="btn btn-primary" to="/my">{t('account.myReports')}</Link>
        <button type="button" className="btn btn-secondary" onClick={recover} disabled={saving}>{t('account.recover')}</button>
      </div>
      {recovered != null && <div className="notice notice-ok" role="status">{recovered > 0 ? t('account.recovered', { n: recovered }) : t('account.recoveredNone')}</div>}
      <p className="hint">{t('account.recover.hint')}</p>

      <h2>{t('account.prefs.title')}</h2>
      <div className="card account-prefs">
        <label className="account-toggle">
          <input type="checkbox" checked={me.prefs.emailUpdates} onChange={(e) => togglePref(e.target.checked)} />
          <span>{t('account.prefs.emailUpdates')}</span>
        </label>
        <p className="hint">{t('account.prefs.emailUpdates.hint')}</p>
        <form className="account-inline" onSubmit={saveName}>
          <label className="label" htmlFor="account-name">{t('account.name.label')}</label>
          <div className="account-row">
            <input id="account-name" className="input" value={name} maxLength={80} autoComplete="name" placeholder={t('account.name.placeholder')} onChange={(e) => setName(e.target.value)} />
            <button type="submit" className="btn btn-secondary" disabled={saving || name.trim() === (me.displayName ?? '')}>{t('account.save')}</button>
          </div>
          <p className="hint">{t('account.name.hint')}</p>
        </form>
      </div>

      <h2>{t('account.addresses.title')}</h2>
      <div className="card">
        {me.addresses.length === 0 && <p className="muted">{t('account.addresses.empty')}</p>}
        <ul className="account-list">
          {me.addresses.map((a) => (
            <li key={a.id}>
              <span><strong>{a.label}</strong><br /><span className="muted">{a.address}</span></span>
              <button type="button" className="btn btn-ghost" onClick={() => removeAddress(a.id)} aria-label={`${t('account.addresses.remove')} ${a.label}`}>{t('account.addresses.remove')}</button>
            </li>
          ))}
        </ul>
        {me.addresses.length < 10 && (
          <form className="account-inline" onSubmit={addAddress}>
            <div className="account-row">
              <input className="input account-label" value={addr.label} maxLength={40} placeholder={t('account.addresses.labelPlaceholder')} aria-label={t('account.addresses.label')} onChange={(e) => setAddr({ ...addr, label: e.target.value })} />
              <input className="input" value={addr.address} maxLength={300} placeholder={t('account.addresses.addressPlaceholder')} aria-label={t('account.addresses.address')} autoComplete="street-address" onChange={(e) => setAddr({ ...addr, address: e.target.value })} />
            </div>
            <button type="submit" className="btn btn-secondary" disabled={saving || addr.address.trim().length < 3}>{t('account.addresses.add')}</button>
          </form>
        )}
      </div>

      <h2>{t('account.following.title')}</h2>
      {following == null ? <p className="muted">{t('account.loading')}</p> : following.length === 0 ? <p className="muted">{t('account.following.empty')}</p> : (
        <ul className="my-list">
          {following.map((r) => (
            <li key={r.id}><Link to={`/r/${r.id}`} className="card my-row">
              <span className="my-cat">{shortLabel(r.category, t)}</span>
              <span className="my-addr">{r.address}</span>
              <span className="muted my-date">{r.createdAt ? new Date(r.createdAt).toLocaleDateString() : ''}</span>
            </Link></li>
          ))}
        </ul>
      )}

      <div className="account-signout">
        <button type="button" className="btn btn-ghost" onClick={() => { signOut(); navigate('/'); }}>{t('account.signOut')}</button>
        <p className="hint">{t('account.signOut.hint')}</p>
      </div>
    </>
  );
}

function errKey(e: unknown): string {
  const code = e instanceof AuthError ? e.code : '';
  if (/INVALID_EMAIL|MISSING_EMAIL/.test(code)) return 'email';
  if (/SEND_FAILED/.test(code)) return 'generic';
  if (/INVALID_OOB_CODE|EXPIRED_OOB_CODE|INVALID_LOGIN_CREDENTIALS/.test(code)) return 'link';
  if (/TOO_MANY_ATTEMPTS|QUOTA/.test(code)) return 'rate';
  return 'generic';
}
