// Firebase Analytics (GA4 stream G-KKLML5QH3L on pvd-snow-report) via plain gtag.js — no Firebase SDK.
// Production hosts only, so dev servers and Playwright never send hits. Page URLs are redacted before they
// leave: tracking links (/r/<token>) are secrets and email sign-in links carry a one-time oobCode, so we send
// the route pattern and keep only utm_* params (launch-channel attribution).
const MEASUREMENT_ID = 'G-KKLML5QH3L';
const PROD_HOSTS = /^(fixmypvd\.org|www\.fixmypvd\.org|pvd-snow-report\.web\.app|pvd-snow-report\.firebaseapp\.com)$/;

type Gtag = (...args: unknown[]) => void;
let gtag: Gtag | null = null;

function redact(loc: Location): { page_location: string; page_path: string } {
  const path = loc.pathname.replace(/^\/r\/[^/]+/, '/r/:id');
  const utm = new URLSearchParams();
  new URLSearchParams(loc.search).forEach((v, k) => { if (k.startsWith('utm_')) utm.set(k, v); });
  const qs = utm.toString();
  return { page_location: `${loc.origin}${path}${qs ? `?${qs}` : ''}`, page_path: path };
}

export function initAnalytics(): void {
  if (gtag || !PROD_HOSTS.test(location.hostname)) return;
  const w = window as unknown as { dataLayer: unknown[]; gtag: Gtag };
  w.dataLayer = w.dataLayer || [];
  // gtag.js reads the `arguments` object itself, so this must stay a function expression.
  w.gtag = function () { w.dataLayer.push(arguments); } as Gtag; // eslint-disable-line prefer-rest-params
  gtag = w.gtag;
  gtag('js', new Date());
  // Page views are sent by trackPageView on each route change (redacted), not automatically.
  gtag('config', MEASUREMENT_ID, { send_page_view: false, ...redact(location) });
  const s = document.createElement('script');
  s.async = true; s.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
  document.head.appendChild(s);
}

export function trackPageView(): void {
  if (!gtag) return;
  const r = redact(location);
  gtag('set', { page_location: r.page_location });
  gtag('event', 'page_view', { ...r, page_title: document.title });
}

/** Fire-and-forget; never throws, no-op off production. Keep params free of PII (no email, address, text). */
export function track(name: string, params?: Record<string, string | number | boolean>): void {
  try { gtag?.('event', name, params); } catch { /* analytics must never break the app */ }
}
