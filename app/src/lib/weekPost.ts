/** "Copy as post" on /week: the week summary as a short Markdown post for r/providence or Nextdoor (Rob posts the
 *  week by hand every Monday). The builder lives in shared/weekPost.ts so the Worker's Monday admin mail carries the
 *  same bytes the button copies; this module re-exports it and keeps `tEn`, the English dictionary as a `t` for callers
 *  that want every app string (the post itself uses shared's inlined English labels unless a `t` is passed). */
import en from '../i18n/strings.en.json' with { type: 'json' };
import { labelsEn, substitute, type PostT } from '@shared/weekPost';

export { weekPostMarkdown, weekPostRange, POST_TOP, OUTCOME_LABELS_EN, GROUP_LABELS_EN, labelsEn } from '@shared/weekPost';
export type { PostT, WeekPostOpts, WeekPostSummary, WeekPostOutcome, WeekPostType, WeekPostHood, WeekPostNotable } from '@shared/weekPost';

const EN = en as Record<string, string>;
/** The English strings, with the same `{var}` substitution as the app's t(); a key the dictionary lacks falls back
 *  to shared's inlined labels, then to the key itself. */
export const tEn: PostT = (key, vars) => (key in EN ? substitute(EN[key], vars) : labelsEn(key, vars));
