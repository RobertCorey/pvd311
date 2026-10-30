// Two sinks for the same events:
//  1. Firebase Analytics (GA4 stream G-KKLML5QH3L on pvd-snow-report) via plain gtag.js — no Firebase SDK.
//  2. First-party POST /api/ui on our own API host (Worker → Analytics Engine; /admin Usage tab). Content
//     blockers stub gtag.js but can't block the API the app needs, so this one counts everyone.
// Production hosts only, so dev servers and local Playwright never send hits — and never from an automated browser
// (navigator.webdriver: Playwright, Puppeteer, chrome-devtools), because by 2026-10-30 our own agent/deploy-check sessions
// on the live site were ~16% of page views and 56 of 69 /street views. The Worker also drops HeadlessChrome user agents
// (worker/src/ui.ts) for automation that hides webdriver. Page URLs are redacted before they
// leave: tracking links (/r/<token>) are secrets and email sign-in links carry a one-time oobCode, so we send
// the route pattern and keep only utm_* params (launch-channel attribution).
import { apiFetch } from '../api/client';

const MEASUREMENT_ID = 'G-KKLML5QH3L';
const PROD_HOSTS = /^(fixmypvd\.org|www\.fixmypvd\.org|pvd-snow-report\.web\.app|pvd-snow-report\.firebaseapp\.com)$/;

type Gtag = (...args: unknown[]) => void;
let gtag: Gtag | null = null;
let firstParty = false;

function stored(store: () => Storage, key: string, make: () => string): string {
  try { const s = store(); let v = s.getItem(key); if (!v) { v = make(); s.setItem(key, v); } return v; } catch { return make(); }
}
const rid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20);
type Params = Record<string, string | number | boolean>;

/** Landing attribution, captured once per tab session: utm_source, else the external referrer's host. */
function landing(): { u: string; r: string } {
  return JSON.parse(stored(() => sessionStorage, 'fixmypvd.landing', () => {
    let r = '';
    try { const h = document.referrer ? new URL(document.referrer).hostname : ''; if (h && h !== location.hostname) r = h; } catch { /* ignore */ }
    return JSON.stringify({ u: new URLSearchParams(location.search).get('utm_source') ?? '', r });
  })) as { u: string; r: string };
}

function sendFirstParty(e: string, params: Params = {}): void {
  if (!firstParty) return;
  const { category, ...rest } = params;
  const body = JSON.stringify({
    e, p: redact(location).page_path, v: stored(() => localStorage, 'fixmypvd.vid', rid), s: stored(() => sessionStorage, 'fixmypvd.sid', rid),
    c: typeof category === 'string' ? category : '', m: Object.entries(rest).map(([k, v]) => `${k}=${v}`).join(','), l: document.documentElement.lang, ...landing(),
  });
  // text/plain keeps it a simple CORS request (no preflight); keepalive lets it outlive a navigation.
  apiFetch('/api/ui', { method: 'POST', headers: { 'content-type': 'text/plain' }, body, keepalive: true }).catch(() => { /* never surface */ });
}

function redact(loc: Location): { page_location: string; page_path: string } {
  const path = loc.pathname.replace(/^\/r\/[^/]+/, '/r/:id');
  const utm = new URLSearchParams();
  new URLSearchParams(loc.search).forEach((v, k) => { if (k.startsWith('utm_')) utm.set(k, v); });
  const qs = utm.toString();
  return { page_location: `${loc.origin}${path}${qs ? `?${qs}` : ''}`, page_path: path };
}

export function initAnalytics(): void {
  if (gtag || !PROD_HOSTS.test(location.hostname) || navigator.webdriver) return;
  firstParty = true;
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
  sendFirstParty('page_view');
  if (!gtag) return;
  const r = redact(location);
  gtag('set', { page_location: r.page_location });
  gtag('event', 'page_view', { ...r, page_title: document.title });
}

/** Fire-and-forget; never throws, no-op off production. Keep params free of PII (no email, address, text). */
export function track(name: string, params?: Params): void {
  try { gtag?.('event', name, params); sendFirstParty(name, params); } catch { /* analytics must never break the app */ }
}
