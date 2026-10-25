import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useT } from '../i18n';
import type { MapCase } from '../lib/streetMap';
import CategoryIcon from './CategoryIcon';
import { PlaceLine, StatusPill, WhenLine } from './StreetRow';
import './StreetParts.css';

/** The selected case's card (spec: .claude/street-map-spec.md "discovery" → CASE CARD). A focusable `<section
 *  tabIndex={-1} aria-labelledby>` that takes focus when it opens (and when the selection changes to another case),
 *  so a row's Enter lands here and never in the map. Escape inside it = "Back to list". The caller owns focus
 *  return (the originating row carries `data-id`), sharing, and the digest card passed as `digest`. */

export interface StreetDetailProps {
  c: MapCase;
  hood?: string | null;
  distanceM?: number | null;
  /** "Back to list" and Escape. The caller returns focus to the originating row or the grabber. */
  onBack: () => void;
  /** "Share": the caller does navigator.share / clipboard and announces "Link copied" in the live region. */
  onShare: () => void;
  /** The `.street-digest` card bound to this case's street (located cases only); rendered after the actions. */
  digest?: ReactNode;
  nowMs: number;
}

export default function StreetDetail({ c, hood, distanceM, onBack, onShare, digest, nowMs }: StreetDetailProps) {
  const t = useT();
  const titleId = useId();
  const ref = useRef<HTMLElement>(null);

  // preventScroll: at HALF the sheet body is overflow:hidden and must not be nudged by the focus move.
  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, [c.id]);

  // Pins placed by street name alone (no house number) stand for the whole street.
  const approx = c.lat != null && c.street !== '' && !/^\d/.test(c.street);

  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    onBack();
  }

  return (
    <section ref={ref} className="card street-detail" tabIndex={-1} aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <div className="street-detail-head">
        <span className="street-icon street-icon--lg"><CategoryIcon k={c.category} size={32} /></span>
        <div className="street-detail-titles">
          <h3 id={titleId} className="street-detail-title">{c.caseType || t(`street.g.${c.group}`)}</h3>
          <PlaceLine c={c} hood={hood} distanceM={distanceM} />
        </div>
        <StatusPill status={c.status} />
      </div>
      <WhenLine c={c} nowMs={nowMs} />
      {!c.open && c.resolution && <blockquote className="street-note">{c.resolution}</blockquote>}
      {approx && <p className="hint street-detail-approx">{t('street.detail.approx')}</p>}
      <div className="street-detail-actions">
        <button type="button" className="btn btn-ghost" onClick={onBack}>{t('street.detail.back')}</button>
        <button type="button" className="btn btn-ghost" onClick={onShare}>{t('street.detail.share')}</button>
        <Link to="/" className="btn btn-secondary">{t('street.report')}</Link>
      </div>
      {digest}
    </section>
  );
}
