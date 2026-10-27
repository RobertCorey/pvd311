import { useSyncExternalStore } from 'react';

interface BeforeInstallPromptEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>; }

// Chromium fires `beforeinstallprompt` ONCE, early in the page's life — before a lazily loaded screen (/street's
// home-screen nudge) has mounted, and often before any component's effect has attached a listener. So the deferred
// event lives here, at module level, captured the moment this module is evaluated (the header imports it, so that is
// app start); every subscriber reads the same prompt whenever it mounts. `appinstalled` and an accepted prompt clear it.
let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as BeforeInstallPromptEvent; notify(); });
  window.addEventListener('appinstalled', () => { deferred = null; notify(); });
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const snapshot = () => deferred;
const none = () => null;

/** Android/Chromium "Add to Home Screen". `canInstall` is false where there is no prompt (iOS, already installed, desktop
 *  browsers that do not offer one); `install()` shows the browser's sheet and resolves to whether it was accepted. */
export function useInstallPrompt(): { canInstall: boolean; install: () => Promise<boolean> } {
  const evt = useSyncExternalStore(subscribe, snapshot, none);
  return {
    canInstall: !!evt,
    install: async () => {
      if (!evt) return false;
      await evt.prompt();
      const { outcome } = await evt.userChoice;
      if (outcome === 'accepted') { deferred = null; notify(); }
      return outcome === 'accepted';
    },
  };
}
