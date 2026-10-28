import type { Ref } from 'react';
import { useI18n } from '../i18n';
import { caseAge, caseDay, type MapCase } from '../lib/streetMap';
import CategoryIcon from './CategoryIcon';
import { PlaceLine, StatusPill } from './StreetRow';
import './StreetParts.css';

/** The phone's pin preview (Rob, 2026-10-28, asked to choose between the case page on every pin tap and Zillow's small
 *  card first: "idk you pick"). Under 720 px a tap on a pin or a fanned pin shows this compact card, docked at the
 *  bottom of the map above the sheet, instead of opening the case page. The card's face is ONE button (spans only
 *  inside, StreetRow's rule): type icon, type, status pill, street · neighborhood, "Reported Oct 24 · open 3 days" and
 *  a chevron; it opens the case page (the caller's openCase, case= as from a row). The small × beside it closes it. A
 *  labelled region, not a dialog: the map, the rail and the sheet stay usable around it. The caller places it
 *  (Street.css .street-preview), moves focus to it, and owns Escape, the background tap, the far pan and where focus
 *  goes after. */

export interface StreetPreviewProps {
  c: MapCase;
  hood: string | null;
  nowMs: number;
  /** The card's face: open the case page. */
  onOpen: () => void;
  /** The ×. */
  onClose: () => void;
  ref?: Ref<HTMLElement>;
}

export default function StreetPreview({ c, hood, nowMs, onOpen, onClose, ref }: StreetPreviewProps) {
  const { t, lang } = useI18n();
  const locale = lang === 'es' ? 'es' : 'en-US';
  // "Reported Oct 24 · open 3 days" / "· closed after 8 days": the case page's stat row in one line.
  const age = caseAge(c, nowMs);
  const ageText = !age ? ''
    : age.open ? (age.days === 0 ? t('street.preview.open.today') : t(age.days === 1 ? 'street.preview.open.one' : 'street.preview.open', { n: age.days }))
    : age.days === 0 ? t('street.preview.closed.same') : t(age.days === 1 ? 'street.preview.closed.one' : 'street.preview.closed', { n: age.days });
  const reported = caseDay(c.createdAt, nowMs, locale);
  const when = [reported ? t('street.preview.reported', { date: reported }) : '', ageText].filter(Boolean).join(' · ');
  return (
    <section ref={ref} className="street-preview" aria-label={t('street.preview.label')} tabIndex={-1} data-id={c.id}>
      <button type="button" className="street-preview-open" onClick={onOpen}>
        <span className="street-icon"><CategoryIcon k={c.category} size={24} /></span>
        <span className="street-preview-main">
          <span className="street-preview-head">
            <span className="street-type">{c.caseType || t(`street.g.${c.group}`)}</span>
            <StatusPill status={c.status} />
          </span>
          <PlaceLine c={c} hood={hood} />
          {when && <span className="street-when">{when}</span>}
        </span>
        <span className="street-preview-go" aria-hidden="true">›</span>
        <span className="street-vh">{t('street.preview.details')}</span>
      </button>
      <button type="button" className="street-ico street-preview-x" aria-label={t('street.preview.close')} onClick={onClose}><span aria-hidden="true">×</span></button>
    </section>
  );
}
