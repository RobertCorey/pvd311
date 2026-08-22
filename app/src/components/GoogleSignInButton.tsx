import { useEffect, useRef } from 'react';
import { GOOGLE_CLIENT_ID, loadGsi, signInWithGoogleCredential, type Session } from '../lib/auth';

/**
 * The GIS "Continue with Google" button → Firebase session. Renders nothing when no client id is configured or the
 * GIS script fails (email link still works). Callbacks are read through refs so parent re-renders never re-initialize GIS.
 */
export default function GoogleSignInButton({ onSignedIn, onError, onBusy, className, width = 300, label }: {
  onSignedIn?: (s: Session) => void; onError?: (e: unknown) => void; onBusy?: () => void; className?: string; width?: number; label?: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const cb = useRef({ onSignedIn, onError, onBusy });
  useEffect(() => { cb.current = { onSignedIn, onError, onBusy }; });
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;
    let cancelled = false;
    loadGsi().then((g) => {
      if (cancelled || !el.current) return;
      g.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID, ux_mode: 'popup', itp_support: true,
        callback: (r: { credential?: string }) => {
          if (!r.credential) return;
          cb.current.onBusy?.();
          signInWithGoogleCredential(r.credential).then((s) => cb.current.onSignedIn?.(s)).catch((e: unknown) => cb.current.onError?.(e));
        },
      });
      g.accounts.id.renderButton(el.current, { type: 'standard', theme: 'outline', size: 'large', shape: 'pill', width, text: 'continue_with', logo_alignment: 'left' });
    }).catch(() => { /* no Google button */ });
    return () => { cancelled = true; };
  }, [width]);
  if (!GOOGLE_CLIENT_ID) return null;
  return <div ref={el} className={className} aria-label={label} />;
}
