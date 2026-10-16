import { Fragment, useCallback, useEffect, useState } from 'react';
import { useT } from '../i18n';
import { adminCityQuestions, type AdminCityQuestion, type AdminCityQuestionFlag, type AdminCityQuestions, type AdminCityQuestionsItem } from '../api/admin';
import { When, abs } from './adminUtil';
import './Admin.css';
import './AdminCityQuestions.css';

type Tr = ReturnType<typeof useT>;

/**
 * /admin → City questions (docs/city-questions.md phase 1, read-only). One row per category × city question, ranked by
 * blanks × weekly demand: what the city's Step-3 form asks for each category (the committed seed, from the city's own
 * show/hide script), how live filings answered it (App / AI / Blank), when the bot last saw it, and drift flags.
 * GET /api/admin/city-questions. No actions in phase 1.
 */
export default function AdminCityQuestions() {
  const t = useT();
  const [data, setData] = useState<AdminCityQuestions | null>(null);
  const [err, setErr] = useState(false);
  const load = useCallback(async () => {
    try { setErr(false); setData(await adminCityQuestions()); } catch { setErr(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const items = data?.items ?? [];
  const nQuestions = items.reduce((n, i) => n + i.questions.length, 0);
  const nFiled = items.filter((i) => i.filings > 0).length;
  const nFlags = items.reduce((n, i) => n + i.flags.length, 0);
  const nBlanks = items.reduce((n, i) => n + i.blanks, 0);

  return (
    <div className="admin-cq">
      <section className="cq-explain" aria-labelledby="cq-how">
        <h2 id="cq-how">{t('admin.cq.how.title')}</h2>
        <dl className="cq-how">
          <div><dt>{t('admin.cq.how.seed.t')}</dt><dd>{t('admin.cq.how.seed')}</dd></div>
          <div><dt>{t('admin.cq.how.filing.t')}</dt><dd>{t('admin.cq.how.filing')}</dd></div>
          <div><dt>{t('admin.cq.how.flags.t')}</dt><dd>{t('admin.cq.how.flags')}</dd></div>
          <div><dt>{t('admin.cq.how.rank.t')}</dt><dd>{t('admin.cq.how.rank')}</dd></div>
        </dl>
      </section>

      {!data ? (
        err
          ? <div className="notice notice-error" role="alert">{t('admin.loadError')} <button type="button" className="btn btn-ghost" onClick={() => void load()}>{t('account.retry')}</button></div>
          : <p className="muted" aria-busy="true">{t('account.loading')}</p>
      ) : (
        <>
          <p className="cq-summary admin-meta">
            {t('admin.cq.summary', { cats: items.length, questions: nQuestions, filed: nFiled, blanks: nBlanks, flags: nFlags })}
            {' · '}<span title={abs(data.seed.generatedAt)}>{t('admin.cq.seedFrom', { dump: data.seed.dump })}</span>
            {' '}<button type="button" className="btn btn-ghost cq-refresh" onClick={() => void load()}>{t('admin.refresh')}</button>
          </p>
          {data.seed.notes.length > 0 && <ul className="cq-notes admin-meta">{data.seed.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
          {items.length === 0 ? <p className="admin-empty">{t('admin.cq.empty')}</p> : (
            <div className="admin-table-wrap">
              <table className="admin-table cq-table">
                <colgroup><col className="cq-c-cat" /><col className="cq-c-q" /><col /><col className="cq-c-ans" /><col className="cq-c-seen" /><col className="cq-c-flags" /></colgroup>
                <thead>
                  <tr>
                    <th scope="col">{t('admin.cq.col.category')}</th>
                    <th scope="col">{t('admin.cq.col.question')}</th>
                    <th scope="col">{t('admin.cq.col.choices')}</th>
                    <th scope="col">{t('admin.cq.col.answered')}</th>
                    <th scope="col">{t('admin.cq.col.seen')}</th>
                    <th scope="col">{t('admin.cq.col.flags')}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it, gi) => <CategoryRows key={it.category} it={it} alt={gi % 2 === 1} t={t} />)}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CategoryRows({ it, alt, t }: { it: AdminCityQuestionsItem; alt: boolean; t: Tr }) {
  const rows = it.questions.length ? it.questions : [null];
  const cls = `cq-row${alt ? ' is-alt' : ''}`;
  return (
    <Fragment>
      {rows.map((q, i) => (
        <tr key={q?.id ?? 'none'} className={cls} data-category={it.category}>
          {i === 0 && (
            <th scope="rowgroup" rowSpan={rows.length} className="cq-cat">
              <div className="cq-cat-label">{it.label}</div>
              <div><span className="sys-kind">{it.category}</span></div>
              <div className="admin-meta">{t('admin.cq.demand', { n: it.demand })}{it.filings > 0 ? ` · ${t('admin.cq.filings', { n: it.filings })}` : ''}</div>
              {it.note && q && <div className="cq-note">{it.note}</div>}
            </th>
          )}
          {q ? <QuestionCells q={q} it={it} t={t} /> : (
            <td colSpan={5}>
              <div className="admin-meta">{t('admin.cq.noQuestions')}</div>
              {it.note && <div className="cq-note">{it.note}</div>}
            </td>
          )}
        </tr>
      ))}
    </Fragment>
  );
}

function QuestionCells({ q, it, t }: { q: AdminCityQuestion; it: AdminCityQuestionsItem; t: Tr }) {
  const flags = it.flags.filter((f) => f.questionId === q.id);
  const { app, ai, blank } = q.counts;
  const filed = it.filings > 0;
  return (
    <>
      <td className="cq-q">
        <div className="cq-q-label">{q.cityLabel}</div>
        <div><span className="sys-kind">{q.id}</span>{!q.inSeed && <span className="admin-meta"> · {t('admin.cq.notInSeed')}</span>}</div>
      </td>
      <td className="cq-choices">
        {q.type === 'toggle' ? <span className="admin-meta">{t('admin.cq.toggle')}</span>
          : q.cityOptions.length === 0 ? <span className="admin-meta">{t(q.type === 'textarea' ? 'admin.cq.freeTextLong' : 'admin.cq.freeText')}</span>
          : <ul className="cq-opts">{q.cityOptions.map((o) => <li key={o} className="cq-opt">{o}</li>)}</ul>}
        {q.mode === 'app' && q.appOptions && q.cityOptions.length > 0 && <div className="admin-meta cq-appopts">{t('admin.cq.appSends', { v: q.appOptions.join(' · ') })}</div>}
      </td>
      <td className="cq-answered">
        {filed
          ? <div className="cq-counts">
              {app > 0 && <span>{t('admin.cq.count.app', { n: app })}</span>}
              {ai > 0 && <span>{t('admin.cq.count.ai', { n: ai })}</span>}
              {(blank > 0 || app + ai === 0) && <span className={blank > 0 ? 'cq-blank' : ''}>{t('admin.cq.count.blank', { n: blank })}</span>}
            </div>
          : <span className={`cq-mode cq-mode--${q.mode}`} title={t(`admin.cq.mode.${q.mode}.title`)}>{t(`admin.cq.mode.${q.mode}`)}</span>}
      </td>
      <td className="cq-seen">
        {!filed ? <span className="admin-meta">{t('admin.cq.notFiled')}</span>
          : q.lastSeenLive ? <When iso={q.lastSeenLive} t={t} />
          : <span className="admin-meta">{t(q.type === 'toggle' ? 'admin.cq.toggleUnseen' : 'admin.cq.notSeen')}</span>}
      </td>
      <td className="cq-flags">
        {flags.length === 0 ? <span className="admin-meta">—</span> : flags.map((f) => <Flag key={f.kind} f={f} t={t} />)}
      </td>
    </>
  );
}

function Flag({ f, t }: { f: AdminCityQuestionFlag; t: Tr }) {
  const detail = [f.added?.length ? `+ ${f.added.join(' · ')}` : '', f.removed?.length ? `− ${f.removed.join(' · ')}` : ''].filter(Boolean);
  return (
    <div className="cq-flag">
      <span className={`admin-flag cq-flag--${f.kind}`} title={t('admin.cq.flagSince', { at: abs(f.firstAt) })}>{t(`admin.cq.flag.${f.kind}`)}</span>
      {detail.map((d) => <div key={d} className="admin-meta">{d}</div>)}
    </div>
  );
}
