import { useEffect, useRef } from 'react';
import { useT } from '../i18n';
import { ALL_CATEGORIES, GROUPS, byKey, inSeason, shortLabel } from '../lib/categories';
import CategoryIcon from './CategoryIcon';
import './CategorySheet.css';

/** "Other / something else" — a bottom sheet that reads like the city: Streets · Trash · Lights · Animals · Other,
 *  one neighborhood-flavored example per category, "I'm not sure" last. Picks feed the same `onPick` as the tiles. */
export default function CategorySheet({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (key: string) => void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    firstRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; prev?.focus?.(); };
  }, [open, onClose]);

  if (!open) return null;
  const unsure = byKey('unsure');

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div ref={ref} className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-head">
          <h2 id="sheet-title">{t('sheet.title')}</h2>
          <button type="button" className="sheet-close" onClick={onClose} aria-label={t('sheet.close')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div className="sheet-body">
          {GROUPS.map((g) => {
            const cats = g.keys.map(byKey).filter((c): c is NonNullable<typeof c> => !!c && inSeason(c));
            if (!cats.length) return null;
            return (
              <section key={g.key} className="sheet-group" aria-labelledby={`sheet-g-${g.key}`}>
                <h3 id={`sheet-g-${g.key}`} className="sheet-group-title">{t(`sheet.group.${g.key}`)}</h3>
                <ul className="sheet-list">
                  {cats.map((c, i) => (
                    <li key={c.key}>
                      <button ref={g.key === 'streets' && i === 0 ? firstRef : undefined} type="button" className="sheet-row" data-category={c.key} onClick={() => onPick(c.key)}>
                        <span className="sheet-icon" aria-hidden="true"><CategoryIcon k={c.key} size={36} /></span>
                        <span className="sheet-text"><span className="sheet-label">{shortLabel(c.key, t)}</span><span className="sheet-example">{t(`sheet.example.${c.key}`)}</span></span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          {unsure && ALL_CATEGORIES.includes(unsure) && (
            <button type="button" className="sheet-row sheet-row--unsure" data-category="unsure" onClick={() => onPick('unsure')}>
              <span className="sheet-icon" aria-hidden="true"><CategoryIcon k="unsure" size={36} /></span>
              <span className="sheet-text"><span className="sheet-label">{shortLabel('unsure', t)}</span><span className="sheet-example">{t('sheet.example.unsure')}</span></span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
