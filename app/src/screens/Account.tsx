import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useT } from '../i18n';
import { GOOGLE_CLIENT_ID, authErrorKey, completeSignInLink, isSignInLink, pendingEmail, sendSignInLink, signOut, takeReturnTo, useSession } from '../lib/auth';
import { getMe, updateMe, type Me } from '../api/me';
import GoogleSignInButton from '../components/GoogleSignInButton';
import AccountUpdates from './AccountUpdates';
import './Account.css';

type Phase = 'idle' | 'busy' | 'sent' | 'error';
/** Account → Updates: every subscription in one place; the mails' footers link here. */
const UPDATES = '/account/updates';

export default function Account() {
  const session = useSession();
  const navigate = useNavigate();
  const updates = useLocation().pathname.replace(/\/+$/, '') === UPDATES;
  // Already signed in and asked to come back somewhere (e.g. a parked report) → go there.
  const returnTo = new URLSearchParams(location.search).get('returnTo');
  useEffect(() => { if (session && returnTo && !isSignInLink()) navigate(takeReturnTo('/my'), { replace: true }); }, [session, returnTo, navigate]);
  // Updates signed out (a mail's "change what you get" link): sign in first, then straight back to the tab.
  if (!session && updates) return <Navigate to={`/account?returnTo=${encodeURIComponent(UPDATES)}`} replace />;
  return <section className="section account">{session ? <SignedIn updates={updates} /> : <SignedOut />}</section>;
}

// ── Signed out: email link + Google ──
function SignedOut() {
  const t = useT();
  const navigate = useNavigate();
  const [email, setEmail] = useState(pendingEmail() ?? '');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const finishing = isSignInLink();
  const [needEmail] = useState(() => finishing && !pendingEmail()); // link opened where it wasn't requested
  const completing = useRef(false); // oobCodes are single-use: never call signInWithEmailLink twice (StrictMode/remount)

  const afterSignIn = useCallback(async () => {
    navigate(takeReturnTo('/my'), { replace: true });
  }, [navigate]);
  const fail = useCallback((err: unknown) => { setPhase('error'); setError(authErrorKey(err)); }, []);

  // Complete an email link when we land on /account?mode=signIn&oobCode=…
  useEffect(() => {
    if (!finishing || completing.current) return;
    const e = pendingEmail();
    if (!e) return; // needEmail is already true → the form asks for it
    completing.current = true;
    setPhase('busy');
    completeSignInLink(e).then(afterSignIn).catch(fail);
  }, [finishing, afterSignIn, fail]);

  async function onSend(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setPhase('busy'); setError(null);
    try {
      if (finishing && needEmail) { if (completing.current) return; completing.current = true; await completeSignInLink(email); await afterSignIn(); return; }
      await sendSignInLink(email, takeReturnTo('/my')); setPhase('sent');
    } catch (err) { completing.current = false; fail(err); }
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
          <GoogleSignInButton className="account-google" label={t('account.google')} width={280} onBusy={() => setPhase('busy')} onSignedIn={() => { void afterSignIn(); }} onError={fail} />
        </div>
      )}
    </>
  );
}

// ── Signed in: the two tabs over one GET /api/me — Account (profile, sign-out) | Updates (AccountUpdates) ──
function SignedIn({ updates }: { updates: boolean }) {
  const t = useT();
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState(false);

  const load = useCallback(async () => {
    try { setMe(await getMe()); setErr(false); } catch (e) {
      if (e instanceof Error && (e as { status?: number }).status === 401) { signOut(); return; }
      setErr(true);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      <h1 className="account-h1">{t('account.signedIn.title')}</h1>
      <nav className="account-tabs" aria-label={t('account.tabs')}>
        <NavLink to="/account" end className="account-tab">{t('account.tab.account')}</NavLink>
        <NavLink to={UPDATES} className="account-tab">{t('account.tab.updates')}</NavLink>
      </nav>
      {!me
        ? (err
          ? <div className="notice notice-error" role="alert">{t('account.error.load')} <button type="button" className="btn btn-ghost" onClick={load}>{t('account.retry')}</button></div>
          : <p className="muted" aria-busy="true">{t('account.loading')}</p>)
        : updates ? <AccountUpdates me={me} setMe={setMe} /> : <Profile me={me} onMe={setMe} />}
    </>
  );
}

/** The Account tab: email, My reports (+ Admin), the name, sign out. */
function Profile({ me, onMe }: { me: Me; onMe: (me: Me) => void }) {
  const t = useT();
  const navigate = useNavigate();
  const [name, setName] = useState(me.displayName ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(false);

  async function saveName(e: React.FormEvent) {
    e.preventDefault(); setSaving(true); setErr(false);
    try { onMe(await updateMe({ displayName: name.trim() || null })); } catch { setErr(true); } finally { setSaving(false); }
  }

  return (
    <>
      <p className="muted account-email">{me.email ?? '—'}</p>
      <div className="account-actions">
        <Link className="btn btn-primary" to="/my">{t('account.myReports')}</Link>
        {me.admin && <Link className="btn btn-secondary" to="/admin">{t('admin.title')}</Link>}
      </div>
      <form className="card account-inline" onSubmit={saveName}>
        <label className="label" htmlFor="account-name">{t('account.name.label')}</label>
        <div className="account-row">
          <input id="account-name" className="input" value={name} maxLength={80} autoComplete="name" placeholder={t('account.name.placeholder')} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="btn btn-secondary" disabled={saving || name.trim() === (me.displayName ?? '')}>{t('account.save')}</button>
        </div>
        <p className="hint">{t('account.name.hint')}</p>
        {err && <div className="notice notice-error" role="alert">{t('account.error.save')}</div>}
      </form>
      <div className="account-signout">
        <button type="button" className="btn btn-ghost" onClick={() => { signOut(); navigate('/'); }}>{t('account.signOut')}</button>
        <p className="hint">{t('account.signOut.hint')}</p>
      </div>
    </>
  );
}
