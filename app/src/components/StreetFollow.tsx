import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useT } from '../i18n';
import './StreetParts.css';

/** The Follow control of a case card on /street (the `follow` slot of StreetDetail). Three states:
 *    signed out      → a ghost link to sign in that returns to this exact URL (`returnTo`)
 *    not following   → `<button aria-pressed=false>` "Follow this request"
 *    following       → the same toggle pressed ("Following — we'll email you…") plus an explicit "Unfollow" ghost button
 *  The caller owns the optimistic state: `onFollow` / `onUnfollow` flip it at once and reject when the Worker says no,
 *  which this control answers with one `role="alert"` line (cleared on the next tap; the caller keys this control by
 *  case id, so a new case starts clean).
 *  `following === null` = signed in but the account has not loaded (`account` says whether it is still loading or
 *  failed): the toggle is `aria-disabled` — never `disabled`, so it keeps focus and a tap still lands — with a hint
 *  underneath; when the load failed, the tap retries it (`onRetry`). While a request is in flight the button stays
 *  enabled too (`aria-busy`; re-entry is ignored), so keyboard and screen-reader users keep their place and hear the
 *  aria-pressed flip.
 *  `email` says whether the Worker will actually mail this account (cityfollow.eligibleFollowers: verified email and
 *  prefs.emailUpdates on): when it won't, the pressed label drops the promise and a hint links to Account.
 *  `push` (the "Notify me on this phone" row, components/PushCard) renders under the pressed toggle only. */

export type FollowAccountState = 'loading' | 'error' | 'ok';
/** 'off' = prefs.emailUpdates is false; 'unverified' = the account's email is not verified. */
export type FollowEmailState = 'ok' | 'off' | 'unverified';

export interface StreetFollowProps {
  signedIn: boolean;
  following: boolean | null;
  /** The current /street URL (path + search), for the sign-in link's returnTo. */
  returnTo: string;
  /** Why `following` is null: still loading (default) or the account load failed. Ignored when it is a boolean. */
  account?: FollowAccountState;
  /** Tapping the not-ready toggle after a failed account load. */
  onRetry?: () => void;
  /** Whether a status mail would reach this account; undefined = unknown yet (the promise is kept). */
  email?: FollowEmailState;
  onFollow: () => Promise<void>;
  onUnfollow: () => Promise<void>;
  /** Shown while following: the web-push row for this phone. */
  push?: ReactNode;
}

export default function StreetFollow({ signedIn, following, returnTo, account = 'loading', onRetry, email, onFollow, onUnfollow, push }: StreetFollowProps) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  if (!signedIn) {
    return <Link to={`/account?returnTo=${encodeURIComponent(returnTo)}`} className="btn btn-ghost street-follow-signin">{t('street.follow.signIn')}</Link>;
  }

  const ready = following != null;
  async function toggle(on: boolean) {
    if (busy) return;
    setBusy(true); setError(false);
    try { await (on ? onFollow() : onUnfollow()); } catch { setError(true); } finally { setBusy(false); }
  }
  function onToggleClick() {
    if (!ready) { if (account === 'error') onRetry?.(); return; }
    void toggle(!on);
  }

  const on = following === true;
  const mails = email == null || email === 'ok';
  return (
    <>
      <button
        type="button"
        className={`btn btn-secondary street-follow-btn${on ? ' street-follow-btn--on' : ''}`}
        aria-pressed={on}
        aria-disabled={ready ? undefined : true}
        aria-busy={busy || undefined}
        onClick={onToggleClick}
      >
        {on && <span className="street-follow-check" aria-hidden="true">✓</span>}
        {on ? t(mails ? 'street.follow.on' : 'street.follow.on.plain') : t('street.follow')}
      </button>
      {on && <button type="button" className="btn btn-ghost" aria-busy={busy || undefined} onClick={() => void toggle(false)}>{t('street.follow.off')}</button>}
      {!ready && account === 'loading' && <p className="hint street-follow-hint" aria-live="polite">{t('street.follow.loading')}</p>}
      {!ready && account === 'error' && <p className="hint street-follow-hint" role="alert">{t('street.follow.accountError')}</p>}
      {on && !mails && (
        <p className="hint street-follow-hint">
          {t(email === 'off' ? 'street.follow.emailOff' : 'street.follow.unverified')} <Link to="/account">{t('street.follow.account')}</Link>
        </p>
      )}
      {error && <p className="hint street-follow-error" role="alert">{t('street.follow.error')}</p>}
      {on && push}
    </>
  );
}
