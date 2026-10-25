import { useCallback, useMemo, useSyncExternalStore } from 'react';

/** The phone/desktop split used by the Street page (the same breakpoint as index.css's tab-bar rule). */
export const DESKTOP_MQ = '(min-width: 720px)';

/**
 * `window.matchMedia(query).matches`, kept live. False where matchMedia is missing (old WebView, unit tests
 * without a window). Re-evaluates on the media query's own `change` event, so a rotation or a resize across
 * the breakpoint re-renders exactly the components that asked.
 */
export function useMediaQuery(query: string): boolean {
  const mq = useMemo(() => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null), [query]);
  const subscribe = useCallback((onChange: () => void) => {
    if (!mq) return () => {};
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [mq]);
  return useSyncExternalStore(subscribe, () => mq?.matches ?? false, () => false);
}
