import { useEffect, useRef } from 'react';

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      reset: (id?: string) => void;
      remove: (id: string) => void;
    };
  }
}

export const TURNSTILE_SITE_KEY: string = (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) ?? '0x4AAAAAAEYpfrjTLnEgk7-y';
const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

let loading: Promise<void> | null = null;
function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (!loading) {
    loading = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = SCRIPT; s.async = true; s.defer = true;
      s.onload = () => res(); s.onerror = () => rej(new Error('turnstile script failed'));
      document.head.appendChild(s);
    });
  }
  return loading;
}

/**
 * Cloudflare Turnstile (managed mode). Calls onToken with a fresh token, or
 * null when it expires/errors. Tests can bypass it: set window.__TURNSTILE_TOKEN__
 * before mount and no script is loaded.
 */
export default function Turnstile({ onToken }: { onToken: (token: string | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const idRef = useRef<string | null>(null);
  const cb = useRef(onToken); cb.current = onToken;

  useEffect(() => {
    const testToken = (window as unknown as { __TURNSTILE_TOKEN__?: string }).__TURNSTILE_TOKEN__;
    if (testToken) { cb.current(testToken); return; }
    let cancelled = false;
    loadScript().then(() => {
      if (cancelled || !ref.current || !window.turnstile) return;
      idRef.current = window.turnstile.render(ref.current, {
        sitekey: TURNSTILE_SITE_KEY,
        theme: 'light',
        size: 'flexible',
        callback: (t: string) => cb.current(t),
        'expired-callback': () => cb.current(null),
        'error-callback': () => cb.current(null),
      });
    }).catch(() => cb.current(null));
    return () => { cancelled = true; if (idRef.current && window.turnstile) window.turnstile.remove(idRef.current); };
  }, []);

  return <div ref={ref} className="turnstile" style={{ minHeight: 65 }} />;
}
