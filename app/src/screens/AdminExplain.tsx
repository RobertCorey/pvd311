import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react';
import { useT } from '../i18n';
import { adminExplain, type ExplainSection } from '../api/admin';
import './Admin.css';
import './AdminExplain.css';

type T = ReturnType<typeof useT>;

/** Render backtick-fenced `code` spans inside a plain string. Even splits are text, odd splits are code. */
function renderCode(s: string): ReactNode[] {
  return s.split('`').map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : <Fragment key={i}>{part}</Fragment>));
}

function fmtLive(v: string | number | boolean | null, t: T): string {
  if (v === null) return '—';
  if (typeof v === 'boolean') return t(v ? 'admin.sys.on' : 'admin.sys.off');
  if (typeof v === 'number') return v.toLocaleString();
  return v;
}

function ExplainLink({ label, href }: { label: string; href: string }) {
  const internal = href.startsWith('#') || href.startsWith('/');
  return internal
    ? <a href={href}>{label}</a>
    : <a href={href} target="_blank" rel="noopener noreferrer">{label}</a>;
}

function Panel({ s, t }: { s: ExplainSection; t: T }) {
  const live = s.live ? Object.entries(s.live) : [];
  return (
    <section id={`explain-${s.key}`} className="card explain-panel">
      <h2>{s.title}</h2>
      <p className="explain-lede">{s.summary}</p>
      {live.length > 0 && (
        <div className="explain-live">
          {live.map(([k, v]) => (
            <span className="explain-chip" key={k}><b>{k}</b> {fmtLive(v, t)}</span>
          ))}
        </div>
      )}
      {s.details.length > 0 && (
        <ul className="explain-details">
          {s.details.map((d, i) => <li key={i}>{renderCode(d)}</li>)}
        </ul>
      )}
      {s.links && s.links.length > 0 && (
        <div className="explain-links">
          <span className="label">{t('admin.explain.links')}</span>
          <ul>{s.links.map((l, i) => <li key={i}><ExplainLink {...l} /></li>)}</ul>
        </div>
      )}
    </section>
  );
}

/**
 * /admin → How it works: long-form docs generated from the enforcing code (GET /api/admin/explain).
 * Sticky mini-TOC + one panel per section. Config rows and other tabs deep-link here via `#explain:<key>`,
 * which we scroll to and briefly flash (the in-page TOC uses plain `#explain-<key>` anchors).
 */
export default function AdminExplain() {
  const t = useT();
  const [data, setData] = useState<{ sections: ExplainSection[] } | null>(null);
  const [err, setErr] = useState(false);
  const [raw, setRaw] = useState(false);

  const load = useCallback(async () => {
    try { setData(await adminExplain()); setErr(false); } catch { setErr(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // Deep-link handling: on mount (after sections render) and on hashchange, jump+flash for `#explain:<key>`.
  useEffect(() => {
    if (!data) return;
    let timer = 0;
    const handle = () => {
      const h = location.hash;
      if (!h.startsWith('#explain:')) return;
      const el = document.getElementById(`explain-${h.slice('#explain:'.length)}`);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.classList.add('explain-flash');
      window.clearTimeout(timer);
      timer = window.setTimeout(() => el.classList.remove('explain-flash'), 1500);
    };
    handle();
    window.addEventListener('hashchange', handle);
    return () => { window.clearTimeout(timer); window.removeEventListener('hashchange', handle); };
  }, [data]);

  if (!data) return err
    ? <div className="notice notice-error" role="alert">{t('admin.explain.error')} <button type="button" className="btn btn-ghost" onClick={() => void load()}>{t('admin.explain.retry')}</button></div>
    : <p className="muted" aria-busy="true">{t('admin.explain.loading')}</p>;

  const sections = data.sections;
  if (sections.length === 0) return <p className="admin-empty">{t('admin.explain.empty')}</p>;

  return (
    <div className="admin-explain">
      <div className="explain-layout">
        <nav className="explain-toc" aria-label={t('admin.explain.toc')}>
          <ul>
            {sections.map((s) => <li key={s.key}><a href={`#explain-${s.key}`}>{s.title}</a></li>)}
          </ul>
        </nav>
        <div className="explain-body">
          {sections.map((s) => <Panel key={s.key} s={s} t={t} />)}
          <div className="explain-raw">
            <button type="button" className="btn btn-ghost" aria-pressed={raw} onClick={() => setRaw((r) => !r)}>
              {t(raw ? 'admin.explain.rawHide' : 'admin.explain.rawShow')}
            </button>
            {raw && <pre>{JSON.stringify(sections, null, 2)}</pre>}
          </div>
        </div>
      </div>
    </div>
  );
}
