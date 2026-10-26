import { useId, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useT } from '../i18n';
import type { Me } from '../api/me';
import { summaryItems, type SummaryIcon, type SummaryItem } from '../lib/updatesSummary';
import type { PushState } from './PushCard';

/** "What you'll hear about": the compact summary at the top of Account → Updates — one sentence per channel that is on
 *  (lib/updatesSummary.ts decides the lines), the whole row one ≥ 44 px link with the phrase that names where it goes in
 *  river: /my, /street, /week, or an in-page jump to the phone block / the group rail below. Text and links only, no
 *  controls — those stay below. "Nothing yet — pick what you want below." when nothing is on. */
export interface UpdatesSummaryProps {
  me: Me;
  /** What the PushCard below reports about this phone (undefined until its first report). */
  pushState: PushState | undefined;
  /** This browser's push endpoint as the PushCard reports it (kept after Turn off, so the stale entry in
   *  `me.push.endpoints` is not counted as another device). */
  pushEndpoint?: string | null;
}

const ICON: Record<SummaryIcon, ReactNode> = {
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>,
  bell: <><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20a2 2 0 0 0 4 0" /></>,
  filter: <path d="M3 5h18l-7 8v6l-4 2v-8z" />,
};

function Row({ item }: { item: SummaryItem }) {
  const body = (
    <>
      <svg className="account-summary-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICON[item.icon]}</svg>
      <span>{item.before}<span className="account-summary-go">{item.link}</span>{item.after}</span>
    </>
  );
  // An in-page jump stays a plain anchor: the browser scrolls to the id; a <Link> would only push the hash.
  return item.to.startsWith('#')
    ? <a className="account-summary-row" href={item.to}>{body}</a>
    : <Link className="account-summary-row" to={item.to}>{body}</Link>;
}

export default function UpdatesSummary({ me, pushState, pushEndpoint }: UpdatesSummaryProps) {
  const t = useT();
  const titleId = useId();
  const items = summaryItems(me, pushState, t, pushEndpoint);
  return (
    <div className="account-summary" data-n={items.length}>
      <h3 className="account-summary-title" id={titleId}>{t('account.summary.title')}</h3>
      {items.length === 0
        ? <p className="account-summary-none muted">{t('account.summary.none')}</p>
        : (
          <ul className="account-summary-list" aria-labelledby={titleId}>
            {items.map((item) => <li key={item.key} data-item={item.key}><Row item={item} /></li>)}
          </ul>
        )}
    </div>
  );
}
