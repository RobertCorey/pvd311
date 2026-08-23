// Small shared bits for the /admin screens (Queue + System).
import type { Light } from '../api/admin';

type T = (k: string, v?: Record<string, string | number>) => string;

export const Dot = ({ status }: { status: Light | 'warn' | 'error' }) => <span className={`sys-dot sys-dot--${status}`} aria-hidden="true" />;

/** Relative time ("2 min ago" / "3 h ago" / "never"); pair with abs() in a title for the exact stamp. */
export function rel(iso: string | null | undefined, t: T): string {
  if (!iso) return t('admin.sys.never');
  const sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(sec)) return t('admin.sys.never');
  if (sec < 45) return t('admin.sys.justNow');
  if (sec < 3600) return t('admin.sys.ago', { v: `${Math.round(sec / 60)} min` });
  if (sec < 86_400) return t('admin.sys.ago', { v: `${Math.round(sec / 3600)} h` });
  return t('admin.sys.ago', { v: `${Math.round(sec / 86_400)} d` });
}
/** Compact relative age for table cells: "now" / "5m" / "3h" / "2d". */
export function age(iso: string | null | undefined): string {
  if (!iso) return '';
  const sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(sec)) return '';
  if (sec < 60) return 'now';
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86_400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86_400)}d`;
}
/** Absolute local timestamp, e.g. "Aug 22, 2:14 PM". Empty for an unparseable value. */
export function abs(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
}
/** <time> with relative text and the absolute stamp on hover. */
export const When = ({ iso, t, compact }: { iso: string | null | undefined; t: T; compact?: boolean }) => (
  <time dateTime={iso ?? undefined} title={abs(iso)}>{compact ? age(iso) : rel(iso, t)}</time>
);
