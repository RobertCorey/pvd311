import { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from '../i18n';
import { adminConfig, type AdminConfigItem } from '../api/admin';
import './Admin.css';
import './AdminConfig.css';

/** Visual grouping of the settings table by key prefix. Order = display order; only non-empty groups render. */
const GROUP_ORDER = ['hitl', 'account', 'turnstile', 'ai', 'app', 'email', 'other'] as const;
type Group = (typeof GROUP_ORDER)[number];

function groupOf(key: string): Group {
  const k = key.toUpperCase();
  if (k.startsWith('HITL_')) return 'hitl';
  if (k.startsWith('ACCOUNT_')) return 'account';
  if (k.startsWith('TURNSTILE')) return 'turnstile';
  if (k.startsWith('AI') || k.startsWith('ANTHROPIC')) return 'ai';
  if (k.startsWith('APP') || k.startsWith('PORTAL')) return 'app';
  if (k.startsWith('RESEND') || k.startsWith('EMAIL') || k.startsWith('NOTIFY') || k.startsWith('AUTH_FROM')) return 'email';
  return 'other';
}

/** Maps a config key to the How-it-works section it belongs to, for the row's "?" deep-link (`#explain:<section>`). */
function guessSection(key: string): string {
  const k = key.toUpperCase();
  if (k.startsWith('HITL') || k.startsWith('ACCOUNT_TRUST')) return 'hitl';
  if (k.startsWith('TURNSTILE') || k.startsWith('PACE') || k.startsWith('RATE') || k.startsWith('INTAKE') || k.startsWith('AI') || k.startsWith('ANTHROPIC')) return 'moderation';
  if (k.startsWith('PORTAL') || k.startsWith('CANARY') || k.startsWith('GOLDEN')) return 'portal';
  if (k.startsWith('RESEND') || k.startsWith('EMAIL') || k.startsWith('NOTIFY') || k.startsWith('AUTH_FROM')) return 'email';
  if (k.startsWith('SYNC') || k.startsWith('RECONCILE') || k.startsWith('WATCHER')) return 'sync';
  if (k.startsWith('RETENTION') || k.startsWith('DATA') || k.startsWith('FIREBASE') || k.startsWith('STORAGE')) return 'data';
  return 'health';
}

type T = ReturnType<typeof useT>;

function ConfigValue({ v, t }: { v: AdminConfigItem['value']; t: T }) {
  if (v === null) return <span className="cfg-null">—</span>;
  if (typeof v === 'boolean') return <span className={`cfg-pill cfg-pill--${v ? 'on' : 'off'}`}>{t(v ? 'admin.sys.on' : 'admin.sys.off')}</span>;
  if (typeof v === 'number') return <span className="cfg-num">{v}</span>;
  return <span className="cfg-str">{v}</span>;
}

/**
 * /admin → Config: every live setting and limit the Worker exposes (GET /api/admin/config), no secrets.
 * Dense table grouped by key prefix, a client-side filter, a per-row "?" that jumps to How-it-works, and a raw-JSON toggle.
 */
export default function AdminConfig() {
  const t = useT();
  const [data, setData] = useState<{ items: AdminConfigItem[] } | null>(null);
  const [err, setErr] = useState(false);
  const [filter, setFilter] = useState('');
  const [raw, setRaw] = useState(false);

  const load = useCallback(async () => {
    try { setData(await adminConfig()); setErr(false); } catch { setErr(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    const list = data?.items ?? [];
    const q = filter.trim().toLowerCase();
    return q ? list.filter((it) => it.key.toLowerCase().includes(q) || it.what.toLowerCase().includes(q)) : list;
  }, [data, filter]);

  const groups = useMemo(() => {
    const m = new Map<Group, AdminConfigItem[]>();
    for (const it of filtered) {
      const g = groupOf(it.key);
      const arr = m.get(g);
      if (arr) arr.push(it); else m.set(g, [it]);
    }
    return GROUP_ORDER.filter((g) => m.has(g)).map((g) => [g, m.get(g)!] as const);
  }, [filtered]);

  if (!data) return err
    ? <div className="notice notice-error" role="alert">{t('admin.config.error')} <button type="button" className="btn btn-ghost" onClick={() => void load()}>{t('admin.config.retry')}</button></div>
    : <p className="muted" aria-busy="true">{t('admin.config.loading')}</p>;

  return (
    <div className="admin-config">
      <div className="cfg-toolbar">
        <input
          type="search"
          className="input cfg-filter"
          placeholder={t('admin.config.filter')}
          aria-label={t('admin.config.filterLabel')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="cfg-count">{t('admin.config.count', { n: filtered.length, total: data.items.length })}</span>
        <button type="button" className="btn btn-ghost cfg-raw-btn" aria-pressed={raw} onClick={() => setRaw((r) => !r)}>
          {t(raw ? 'admin.config.rawHide' : 'admin.config.rawShow')}
        </button>
      </div>

      {raw ? (
        <pre className="cfg-raw">{JSON.stringify(data.items, null, 2)}</pre>
      ) : filtered.length === 0 ? (
        <p className="admin-empty">{t('admin.config.noMatch')}</p>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table cfg-table">
            <thead>
              <tr>
                <th scope="col">{t('admin.config.col.key')}</th>
                <th scope="col">{t('admin.config.col.value')}</th>
                <th scope="col">{t('admin.config.col.what')}</th>
                <th scope="col"><span className="visually-hidden">{t('admin.config.col.help')}</span></th>
              </tr>
            </thead>
            <tbody>
              {groups.map(([g, items]) => (
                <GroupRows key={g} label={t(`admin.config.group.${g}`)} count={items.length}>
                  {items.map((it) => (
                    <tr key={it.key}>
                      <td className="cfg-key"><code>{it.key}</code></td>
                      <td className="cfg-val"><ConfigValue v={it.value} t={t} /></td>
                      <td className="cfg-what">{it.what}</td>
                      <td className="cfg-help">
                        <a href={`#explain:${guessSection(it.key)}`} aria-label={t('admin.config.help')}>?</a>
                      </td>
                    </tr>
                  ))}
                </GroupRows>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function GroupRows({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  return (
    <>
      <tr className="cfg-group">
        <th colSpan={4} scope="colgroup">{label} <span className="admin-count">{count}</span></th>
      </tr>
      {children}
    </>
  );
}
