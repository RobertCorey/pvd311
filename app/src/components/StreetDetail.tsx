import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../i18n';
import { caseAge, caseTimeline, fullAddressLine, type CaseDetail, type MapCase } from '../lib/streetMap';
import CategoryIcon from './CategoryIcon';
import './StreetParts.css';

/** The selected case's card — the body of the case overlay (Rob, 2026-10-27: "When you click on a pin it should show an
 *  overlay with all the case details"). The sheet/panel header above it carries the case type, the status pill and the
 *  × ("Back to list"), so the card has no title of its own: it is labelled by that header's type (`labelledBy`) and
 *  described by its pill (`describedBy`) — the pill comes before the card, so reading on from the focused card would
 *  never reach the city's status. A focusable
 *  `<section tabIndex={-1}>` that takes focus when it opens (and when the selection changes to another case), so a
 *  row's Enter lands here and never in the map; Escape inside it = "Back to list". Order: the key facts (street, hood ·
 *  distance, reported date · how long open / how long to close — visible at the detent a pin tap opens), then what GET
 *  /api/street/case/:id adds (full address, timeline, the city's note, the city-question answers; a skeleton while it
 *  loads, nothing extra when it fails), the actions and the digest card. Answers are text nodes, never HTML. The caller
 *  owns focus return (the originating row carries `data-id`), sharing, and the digest card passed as `digest`. */

export interface StreetDetailProps {
  c: MapCase;
  /** id of the header's <h2> (the case type): the card's accessible name. */
  labelledBy: string;
  /** id of the header's status pill (StreetSheet `badgeId`): the card's accessible description. */
  describedBy?: string;
  hood?: string | null;
  distanceM?: number | null;
  /** Escape. The caller returns focus to the originating row or the grabber (the header × calls the same). */
  onBack: () => void;
  /** "Share": the caller does navigator.share / clipboard and announces "Link copied" in the live region. */
  onShare: () => void;
  /** The `.street-digest` card bound to this case's street (located cases only); rendered after the actions. */
  digest?: ReactNode;
  /** The Follow control (components/StreetFollow), first in the actions row; the caller owns its state. */
  follow?: ReactNode;
  nowMs: number;
  /** GET /api/street/case/:id's `detail`: 'loading' → a small skeleton; 'error' or no detail → the basic card only. */
  more?: { state: 'loading' | 'ok' | 'error'; detail: CaseDetail | null };
}

const TZ = 'America/New_York';

export default function StreetDetail({ c, labelledBy, describedBy, hood, distanceM, onBack, onShare, digest, follow, nowMs, more }: StreetDetailProps) {
  const { t, lang } = useI18n();
  const tlId = useId();
  const ref = useRef<HTMLElement>(null);
  const locale = lang === 'es' ? 'es' : 'en-US';

  // preventScroll: the body must not be nudged by the focus move; a new case starts at the top of its scroller.
  useEffect(() => {
    const el = ref.current;
    const scroller = el?.closest<HTMLElement>('.street-sheet .street-body, .street-panel');
    if (scroller) scroller.scrollTop = 0;
    el?.focus({ preventScroll: true });
  }, [c.id]);

  /** "Oct 24" (the year too when it is not this one), in Providence's time. '' when it will not parse. */
  const day = (iso: string | null) => {
    const ms = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(ms)) return '';
    const sameYear = new Date(ms).getUTCFullYear() === new Date(nowMs).getUTCFullYear();
    return new Date(ms).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric', timeZone: TZ });
  };

  // Pins placed by street name alone (no house number) stand for the whole street.
  const approx = c.lat != null && c.street !== '' && !/^\d/.test(c.street);
  const where = [hood, distanceM != null ? t('street.distance', { m: distanceM }) : null].filter(Boolean).join(' · ');
  const age = caseAge(c, nowMs);
  const ageText = !age ? ''
    : age.open ? (age.days === 0 ? t('street.case.openToday') : t(age.days === 1 ? 'street.case.openDays.one' : 'street.case.openDays', { n: age.days }))
    : age.days === 0 ? t('street.case.closedSameDay') : t(age.days === 1 ? 'street.case.closedAfter.one' : 'street.case.closedAfter', { n: age.days });
  const reported = day(c.createdAt);
  const when = [reported ? t('street.case.reportedOn', { date: reported }) : '', ageText].filter(Boolean).join(' · ');

  const detail = more?.state === 'ok' ? more.detail : null;
  const full = detail ? fullAddressLine(c.street, detail.address) : null;
  const steps = detail ? caseTimeline(c, detail) : [];
  const after = (n: number) => (n === 0 ? t('street.case.after.same') : t(n === 1 ? 'street.case.after.one' : 'street.case.after', { n }));

  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    onBack();
  }

  return (
    <section ref={ref} className="card street-detail" tabIndex={-1} aria-labelledby={labelledBy} aria-describedby={describedBy} aria-busy={more?.state === 'loading' || undefined} onKeyDown={onKeyDown}>
      <div className="street-detail-head">
        <span className="street-icon street-icon--lg"><CategoryIcon k={c.category} size={32} /></span>
        <p className="street-facts">
          <span className="street-fact-place">{c.street || t('street.noStreet')}</span>
          {where && <span className="street-addr">{where}</span>}
          {when && <span className="street-fact-when">{when}</span>}
        </p>
      </div>
      {more?.state === 'loading' && <div className="street-detail-skel" aria-hidden="true"><span /><span /><span /></div>}
      {full && <p className="street-fulladdr"><span className="street-fact-k">{t('street.case.address')}</span> {full}</p>}
      {steps.length > 1 && (
        <div className="street-tl-wrap">
          <h3 id={tlId} className="street-h">{t('street.case.timeline')}</h3>
          <ol className="street-tl" aria-labelledby={tlId}>
            {steps.map((s) => (
              <li key={s.step} className="street-tl-step" data-step={s.step}>
                <span className="street-tl-label">{t(`street.case.step.${s.step}`)}</span>
                <time className="street-tl-date" dateTime={s.at}>{day(s.at)}</time>
                {s.days != null && <span className="street-tl-days">{after(s.days)}</span>}
              </li>
            ))}
          </ol>
        </div>
      )}
      {!c.open && c.resolution && <blockquote className="street-note">{c.resolution}</blockquote>}
      {detail && detail.answers.length > 0 && (
        <div className="street-answers-wrap">
          <h3 className="street-h">{t('street.case.answers')}</h3>
          <dl className="street-answers">
            {detail.answers.map((a, i) => <div key={i}><dt>{a.label}</dt><dd>{a.value}</dd></div>)}
          </dl>
        </div>
      )}
      {approx && <p className="hint street-detail-approx">{t('street.detail.approx')}</p>}
      <div className="street-detail-actions">
        {follow}
        <button type="button" className="btn btn-ghost" onClick={onShare}>{t('street.detail.share')}</button>
        <Link to="/" className="btn btn-secondary">{t('street.report')}</Link>
      </div>
      {digest}
    </section>
  );
}
