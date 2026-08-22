import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useT } from '../i18n';
import { shortLabel } from '../lib/categories';
import { AuthError, GOOGLE_CLIENT_ID, loadGsi, pendingEmail, sendSignInLink, signInWithGoogleCredential } from '../lib/auth';
import CategoryIcon from './CategoryIcon';
import './SignInGate.css';

/**
 * Sign-in gate (accounts are required to report). Mounts at the SEND step: when a signed-out reporter taps
 * "Send to Providence 311", this card replaces the sticky submit bar while the composed report stays visible
 * above it — it reads as "one more step", not a wall. Visual contract: docs/design-direction.md § "Sign-in gate".
 * Logic/props owned by the accounts lead (bob persists the draft across the email-link round trip).
 *
 * `returnTo` is remembered so the email link (which lands on /account) can resume the report.
 */
export interface SignInGateProps {
  /** Category key of the draft — used for the small "step" header (omitted → no strip). */
  category?: string;
  /** Where to come back to after sign-in, e.g. `/`. Carried inside the email link, so it survives a new tab. */
  returnTo: string;
  /** Dismiss the gate (keeps the draft, shows the submit bar again). Omitted → no back button. */
  onBack?: () => void;
  /** Called once a Google sign-in completes in place (email links complete on /account and navigate to returnTo). */
  onSignedIn?: () => void;
}

type Phase = 'idle' | 'busy' | 'sent' | 'error';

export default function SignInGate({ category, returnTo, onBack, onSignedIn }: SignInGateProps) {
  const t = useT();
  const [email, setEmail] = useState(pendingEmail() ?? '');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const gBtn = useRef<HTMLDivElement>(null);

  // Bring the card into view (it appears where the Send bar was) and focus the email field.
  useEffect(() => { inputRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); inputRef.current?.focus({ preventScroll: true }); }, []);

  const fail = useCallback((err: unknown) => {
    const code = err instanceof AuthError ? err.code : '';
    setPhase('error');
    setError(/EMAIL/.test(code) ? 'email' : /TOO_MANY|RATE/.test(code) ? 'rate' : 'generic');
  }, []);

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;
    let cancelled = false;
    loadGsi().then((g) => {
      if (cancelled || !gBtn.current) return;
      g.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID, ux_mode: 'popup', itp_support: true,
        callback: (r: { credential?: string }) => {
          if (!r.credential) return;
          setPhase('busy');
          signInWithGoogleCredential(r.credential).then(() => onSignedIn?.()).catch(fail);
        },
      });
      g.accounts.id.renderButton(gBtn.current, { type: 'standard', theme: 'outline', size: 'large', shape: 'pill', width: 300, text: 'continue_with', logo_alignment: 'left' });
    }).catch(() => { /* no Google button; email link still works */ });
    return () => { cancelled = true; };
  }, [fail, onSignedIn]);

  // Not a <form>: the gate mounts INSIDE the Report form, and nested forms make the browser submit the outer one
  // natively (observed live: GET /? and the draft reloads). Enter in the field and the button both call onSend.
  async function onSend(e?: { preventDefault?: () => void }) {
    e?.preventDefault?.();
    if (!email.trim() || phase === 'busy') return;
    setPhase('busy'); setError(null);
    try { await sendSignInLink(email, returnTo); setPhase('sent'); } catch (err) { fail(err); }
  }

  return (
    <section className="gate rise" aria-labelledby="gate-title">
      <div className="gate-card">
        {category && (
          <div className="gate-step">
            <span className="gate-step-icon" aria-hidden="true"><CategoryIcon k={category} size={28} /></span>
            <span className="gate-step-text">{t('gate.step', { category: shortLabel(category, t) })}</span>
          </div>
        )}

        {phase === 'sent' ? (
          <div className="gate-sent" role="status" aria-live="polite">
            <span className="gate-mail" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7l9 6 9-6" /><rect x="3" y="5" width="18" height="14" rx="2" /></svg>
            </span>
            <h2 id="gate-title">{t('gate.sent.title')}</h2>
            <p className="gate-sub">{t('gate.sent.body', { email: email.trim() })}</p>
            <p className="hint">{t('gate.sent.hint')}</p>
            <button type="button" className="btn btn-ghost" onClick={() => setPhase('idle')}>{t('gate.sent.again')}</button>
          </div>
        ) : (
          <>
            <h2 id="gate-title">{t('gate.title')}</h2>
            <p className="gate-sub">{t('gate.why')}</p>

            <div className="gate-form" role="group" aria-labelledby="gate-title">
              <label className="label" htmlFor="gate-email">{t('gate.email.label')}</label>
              <input ref={inputRef} id="gate-email" className="input" type="email" inputMode="email" autoComplete="email" enterKeyHint="send"
                placeholder={t('gate.email.placeholder')} value={email} onChange={(e) => setEmail(e.target.value)} required
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void onSend(); } }} />
              <button type="button" className="btn btn-primary" disabled={!email.trim() || phase === 'busy'} onClick={() => { void onSend(); }}>
                {phase === 'busy' ? t('gate.email.sending') : t('gate.email.submit')}
              </button>
              <p className="hint gate-next">{t('gate.email.next')}</p>
              {error && <div className="notice notice-error" role="alert">{t(`gate.error.${error}`)}</div>}
            </div>

            {GOOGLE_CLIENT_ID && (
              <div className="gate-or">
                <span className="gate-or-line" aria-hidden="true" /><span className="muted">{t('gate.or')}</span><span className="gate-or-line" aria-hidden="true" />
                <div ref={gBtn} className="gate-google" aria-label={t('gate.google')} />
              </div>
            )}
          </>
        )}

        <p className="gate-fine">{t('gate.fine')} <Link to="/privacy">{t('nav.privacy')}</Link></p>
      </div>
      {onBack && <button type="button" className="btn btn-ghost gate-back" onClick={onBack}>{t('gate.back')}</button>}
    </section>
  );
}
