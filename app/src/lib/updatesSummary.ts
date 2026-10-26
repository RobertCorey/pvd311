// "What you'll hear about" (components/UpdatesSummary, at the top of Account → Updates): one line per channel the
// account has on, as a plain sentence with a link. Pure: the lines are computed here from GET /api/me and what the
// PushCard reports about this phone, so the variants are testable without a browser (tests/push.spec.ts).
import { GROUP_ORDER } from '@shared/categories';
import type { Me } from '../api/me';
import type { PushState } from '../components/PushCard';

/** Element ids of the controls the in-page lines jump to (Account.tsx passes them to the three phone-block rows). */
export const PHONE_ID = 'account-phone';   // the PushCard ("Notify me on this phone")
export const WATCH_ID = 'account-watch';   // the StreetWatchRow — the phone line's target where the PushCard renders nothing
export const GROUPS_ID = 'account-groups'; // the WatchGroups rail ("Only tell me about")
/** How many group labels the "Only about" line spells out before "+N". */
export const GROUPS_SHOWN = 4;

export type Tr = (key: string, vars?: Record<string, string | number>) => string;
export type SummaryIcon = 'mail' | 'calendar' | 'bell' | 'filter';
export interface SummaryItem {
  /** Which channel: `reports` (my reports + followed city requests), `street` (Monday street digest), `week` (This
   *  week in Providence), `watch` (instant pushes), `groups` (the type filter). */
  key: 'reports' | 'street' | 'week' | 'watch' | 'groups';
  icon: SummaryIcon;
  /** The sentence around the link: `before` + link + `after`. */
  before: string;
  link: string;
  after: string;
  /** A route (`/my`, `/street`, `/week`) or an in-page anchor (`#account-…`). */
  to: string;
}

/** Splits a sentence on its `{link}` slot. A translation that lost the slot keeps the whole sentence as `before`. */
function sentence(t: Tr, key: string, link: string, to: string, item: Pick<SummaryItem, 'key' | 'icon'>, vars?: Record<string, string | number>): SummaryItem {
  const [before = '', after = ''] = t(key, vars).split('{link}');
  return { ...item, before, link, after, to };
}

/** The lines, in the card's own order: city updates (prefs.emailUpdates; n = followed city requests), the Monday street
 *  digest (located saved addresses, or "save a place first"), the week digest, the instant notifications (on this phone
 *  when the PushCard reports 'on'; else on the account's other devices; else "turn on phone notifications first"), and
 *  the type filter — only while the watch or the digest it narrows is on, since the rail itself is shown only then.
 *  Empty when nothing is on. `thisPhone` is the endpoint the PushCard reports for this browser: after Turn off the
 *  account's list still carries it until the next GET /api/me, so it is not counted as another device. */
export function summaryItems(me: Me, pushState: PushState | undefined, t: Tr, thisPhone?: string | null): SummaryItem[] {
  const items: SummaryItem[] = [];
  const p = me.prefs;
  if (p.emailUpdates) {
    const n = (me.cityFollowing ?? []).length;
    const link = n === 0 ? t('account.summary.reports.link.zero') : n === 1 ? t('account.summary.reports.link.one') : t('account.summary.reports.link', { n });
    items.push(sentence(t, 'account.summary.reports', link, '/my', { key: 'reports', icon: 'mail' }));
  }
  if (p.streetDigest === true) {
    const n = me.addresses.filter((a) => a.lat != null && a.lng != null).length;
    items.push(n === 0
      ? sentence(t, 'account.summary.street.none', t('account.summary.street.none.link'), '/street', { key: 'street', icon: 'calendar' })
      : sentence(t, 'account.summary.street', n === 1 ? t('account.summary.street.link.one') : t('account.summary.street.link', { n }), '/street', { key: 'street', icon: 'calendar' }));
  }
  if (p.weekDigest === true) items.push(sentence(t, 'account.summary.week', t('account.summary.week.link'), '/week', { key: 'week', icon: 'calendar' }));
  if (p.streetWatch === true) {
    const here = pushState === 'on';
    // Not 'on' here → every endpoint the account holds is another device, except this phone's own (just turned off,
    // or held by this browser under another account).
    const devices = (me.push?.endpoints ?? []).filter((e) => e !== thisPhone).length;
    const to = `#${pushState === 'unsupported' ? WATCH_ID : PHONE_ID}`;
    const item = { key: 'watch', icon: 'bell' } as const;
    if (here) items.push(sentence(t, 'account.summary.watch.here', t('account.summary.watch.link'), to, item));
    else if (devices > 0) items.push(sentence(t, devices === 1 ? 'account.summary.watch.other.one' : 'account.summary.watch.other', t('account.summary.watch.link'), to, item, { n: devices }));
    else items.push(sentence(t, 'account.summary.watch.none', t('account.summary.watch.none.link'), to, item));
  }
  if (p.streetWatch === true || p.streetDigest === true) {
    const chosen = p.watchGroups ?? [];
    const groups = GROUP_ORDER.filter((g) => chosen.includes(g));
    if (groups.length) {
      const labels = groups.slice(0, GROUPS_SHOWN).map((g) => t(`street.g.${g}`));
      const rest = groups.length - labels.length;
      const link = labels.join(', ') + (rest ? ` ${t('account.summary.groups.more', { n: rest })}` : '');
      items.push(sentence(t, 'account.summary.groups', link, `#${GROUPS_ID}`, { key: 'groups', icon: 'filter' }));
    }
  }
  return items;
}
