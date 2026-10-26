import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getWeek } from '../api/week';
import { track } from '../lib/analytics';
import { useI18n } from '../i18n';

/** The check-in strip at the foot of the home picker (Rob's rule for '/', 2026-08: reporting first, no clutter — this
 *  is the one quiet pointer at the map-first /street and /week pages, 2026-10-26). One muted line, "312 requests to 311
 *  this week · 114 closed", from GET /api/week (api/week.ts getWeek, 5-minute cache) over two Bricolage links: See the
 *  map → /street and The week → /week. The links render at once; the line is a skeleton bar of the same height until the
 *  numbers land (under 400 px the line box reserves two lines in both states, since the loaded text wraps there), and a failed fetch or an empty week reads "See what the city is working on" instead — never an error
 *  state, never hidden links. Mounted only with the level-1 group grid (Report.tsx), so the fetch starts after the
 *  picker's first paint, below the fold on a phone, and never runs while a report is being composed. Surface card, ink
 *  and muted only: the ember Take-photo / Send actions stay the loudest things on the screen. */
export default function HomeWeekStrip() {
  const { t, lang } = useI18n();
  /** undefined = loading; null = quiet (failed, or a week with nothing in it). */
  const [week, setWeek] = useState<{ total: number; closed: number } | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    getWeek()
      .then((d) => { if (live) setWeek(d.total > 0 ? { total: d.total, closed: d.closed } : null); })
      .catch(() => { if (live) setWeek(null); });
    return () => { live = false; };
  }, []);
  const num = (n: number) => n.toLocaleString(lang === 'es' ? 'es' : 'en-US');
  const state = week === undefined ? 'loading' : week ? 'ok' : 'quiet';
  return (
    <section className="card home-week" data-state={state} aria-busy={state === 'loading' || undefined}>
      {week === undefined
        ? <p className="home-week-line home-week-line--skel" aria-hidden="true"><span /></p>
        : <p className="home-week-line">{week ? t('home.week.line', { total: num(week.total), closed: num(week.closed) }) : t('home.week.quiet')}</p>}
      <div className="home-week-links">
        <Link to="/street" className="home-week-link" onClick={() => track('home_week_map')}>{t('home.week.map')}<span aria-hidden="true">›</span></Link>
        <Link to="/week" className="home-week-link" onClick={() => track('home_week_week')}>{t('home.week.week')}<span aria-hidden="true">›</span></Link>
      </div>
    </section>
  );
}
