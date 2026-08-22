import { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>; }

/** Android/Chromium "Add to Home Screen". Returns null when not available (iOS, already installed). */
export function useInstallPrompt(): { canInstall: boolean; install: () => Promise<boolean> } {
  const [evt, setEvt] = useState<BeforeInstallPromptEvent | null>(null);
  useEffect(() => {
    const onPrompt = (e: Event) => { e.preventDefault(); setEvt(e as BeforeInstallPromptEvent); };
    const onInstalled = () => setEvt(null);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => { window.removeEventListener('beforeinstallprompt', onPrompt); window.removeEventListener('appinstalled', onInstalled); };
  }, []);
  return {
    canInstall: !!evt,
    install: async () => {
      if (!evt) return false;
      await evt.prompt();
      const { outcome } = await evt.userChoice;
      if (outcome === 'accepted') setEvt(null);
      return outcome === 'accepted';
    },
  };
}

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
