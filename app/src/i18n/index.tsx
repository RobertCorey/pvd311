import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import en from './strings.en.json';

type Dict = Record<string, string>;
const DICTS: Record<string, () => Promise<Dict>> = {
  en: async () => en as Dict,
  es: async () => (await import('./strings.es.json')).default as Dict,
};

interface I18n { lang: string; t: (key: string, vars?: Record<string, string | number>) => string; setLang: (l: string) => void; }
const Ctx = createContext<I18n>({ lang: 'en', t: (k) => k, setLang: () => {} });

export function detectLang(): string {
  try {
    const saved = localStorage.getItem('snappvd.lang');
    if (saved && DICTS[saved]) return saved;
  } catch { /* ignore */ }
  const nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return DICTS[nav] ? nav : 'en';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState(detectLang);
  const [dict, setDict] = useState<Dict>(lang === 'en' ? (en as Dict) : {});
  if (lang !== 'en' && Object.keys(dict).length === 0) DICTS[lang]().then(setDict);
  const setLang = useCallback((l: string) => {
    if (!DICTS[l]) return;
    setLangState(l);
    try { localStorage.setItem('snappvd.lang', l); } catch { /* ignore */ }
    DICTS[l]().then(setDict);
  }, []);
  const t = useCallback((key: string, vars?: Record<string, string | number>) => {
    let s = dict[key] ?? (en as Dict)[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
    return s;
  }, [dict]);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  const value = useMemo(() => ({ lang, t, setLang }), [lang, t, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useT = () => useContext(Ctx).t;
export const useI18n = () => useContext(Ctx);
