import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useT } from '../i18n';
import './StreetParts.css';

/** The Follow control of the case page on /street (components/StreetCasePage, the top bar's right side). Three states:
 *    signed out      → a ghost link "Follow" (named "Sign in to follow this request") that returns to this exact URL (`returnTo`)
 *    not following   → `<button aria-pressed=false>` "Follow"
 *    following       → the same toggle pressed ("✓ Following"); a tap on it unfollows
 *  The bar has room for the toggle only, so everything that goes with it — "We'll email you when the city updates it",
 *  the hints and the error line — is portalled into `notes`, an element the page keeps under
 *  the case's title (one React tree, so busy/error state stays here). Not rendered until `notes` exists.
 *  The caller owns the optimistic state: `onFollow` / `onUnfollow` flip it at once and reject when the Worker says no,
 *  which this control answers with one `role="alert"` line (cleared on the next tap; the caller keys this control by
 *  case id, so a new case starts clean).
 *  `following === null` = signed in but the account has not loaded (`account` says whether it is still loading or
 *  failed): the toggle is `aria-disabled` — never `disabled`, so it keeps focus and a tap still lands — with a hint
 *  under the title; when the load failed, the tap retries it (`onRetry`). While a request is in flight the button stays
 *  enabled too (`aria-busy`; re-entry is ignored), so keyboard and screen-reader users keep their place and hear the
 *  aria-pressed flip.
 *  `email` says whether the Worker will actually mail this account (cityfollow.eligibleFollowers: verified email and
 *  prefs.emailUpdates on): when it won't, the line under the title drops the promise and links to Account → Updates instead. */

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
  /** Where the lines that go with the toggle render (see above); null while the page has not mounted it. */
  notes: HTMLElement | null;
}

export default function StreetFollow({ signedIn, following, returnTo, account = 'loading', onRetry, email, onFollow, onUnfollow, notes }: StreetFollowProps) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  if (!signedIn) {
    return (
      <Link to={`/account?returnTo=${encodeURIComponent(returnTo)}`} className="btn btn-ghost street-follow-signin" aria-label={t('street.follow.signIn')}>
        {t('street.follow.short')}
      </Link>
    );
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
  const lines = (
    <>
      {!ready && account === 'loading' && <p className="hint street-follow-hint" aria-live="polite">{t('street.follow.loading')}</p>}
      {!ready && account === 'error' && <p className="hint street-follow-hint" role="alert">{t('street.follow.accountError')}</p>}
      {on && (mails ? <p className="hint street-follow-note">{t('street.follow.mails')}</p> : (
        <p className="hint street-follow-hint">
          {t(email === 'off' ? 'street.follow.emailOff' : 'street.follow.unverified')} <Link to="/account/updates">{t('street.follow.account')}</Link>
        </p>
      ))}
      {error && <p className="hint street-follow-error" role="alert">{t('street.follow.error')}</p>}
    </>
  );
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
        {on ? t('street.follow.on.plain') : t('street.follow.short')}
      </button>
      {notes && createPortal(lines, notes)}
    </>
  );
}
