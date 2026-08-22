/**
 * PVD311 Worker — SPIKE: prove Cloudflare Browser Run can drive the city portal.
 *   GET /canary  (header: x-canary-token: <CANARY_TOKEN>)
 * Logs in, loads the wizard (Step 1 only — never clicks Next, so no draft), asserts the selectors the
 * submitter depends on, and reports the browser's egress IP + any WAF challenge. Read-only.
 */
import { launch, type Browser } from '@cloudflare/playwright';

export interface Env {
  BROWSER: Fetcher;
  PORTAL_BASE_URL: string;
  PORTAL_EMAIL: string;
  PORTAL_PASSWORD: string;
  CANARY_TOKEN: string;
}

const STEP1_SELECTORS: Record<string, string> = {
  requestType: '#casetypecode',
  caseTypeLaunch: 'button[aria-label*="Case Type" i][aria-label*="lookup modal" i]',
  notificationMethod: '#cop_methodofupdate',
  nextButton: '#NextButton',
  honeypot: 'input[id^="frm_pref_"]',
};

interface CanaryReport {
  ok: boolean;
  egressIp: string | null;
  loginOk: boolean;
  wafChallenge: boolean;
  missing: string[];
  notes: string[];
  timings: Record<string, number>;
  error?: string;
}

async function runCanary(env: Env): Promise<CanaryReport> {
  const r: CanaryReport = { ok: false, egressIp: null, loginOk: false, wafChallenge: false, missing: [], notes: [], timings: {} };
  const t0 = Date.now();
  let browser: Browser | null = null;
  try {
    browser = await launch(env.BROWSER);
    r.timings.launchMs = Date.now() - t0;
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });

    // Which IP the city portal will see (browser egress, not the Worker's fetch egress)
    await page.goto('https://api.ipify.org?format=json', { timeout: 20_000 });
    r.egressIp = JSON.parse((await page.textContent('body').catch(() => '{}')) || '{}').ip ?? null;

    // Login
    const t1 = Date.now();
    const resp = await page.goto(`${env.PORTAL_BASE_URL}/SignIn?returnUrl=%2F`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    r.notes.push(`signin http ${resp?.status()}`);
    const body = (await page.textContent('body').catch(() => '')) || '';
    if (/access denied|request blocked|challenge|verify you are human|403/i.test(body) && !/sign in/i.test(body)) r.wafChallenge = true;
    await page.fill('#Username', env.PORTAL_EMAIL);
    await page.fill('#PasswordValue', env.PORTAL_PASSWORD);
    await page.click('#submit-signin-local');
    await page.waitForURL('**/', { timeout: 30_000 });
    r.loginOk = !!(await page.$('.username'));
    r.timings.loginMs = Date.now() - t1;
    if (!r.loginOk) { r.error = 'login failed (no .username after sign-in)'; return r; }

    // Wizard Step 1 — selectors only, no Next
    const t2 = Date.now();
    await page.goto(`${env.PORTAL_BASE_URL}/my-requests/New-Request/`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(4_000);
    for (const [name, sel] of Object.entries(STEP1_SELECTORS)) {
      const ok = name === 'honeypot'
        ? (await page.locator(sel).count().catch(() => 0)) > 0
        : await page.locator(sel).first().isVisible().catch(() => false);
      if (!ok) r.missing.push(`step1.${name}`);
    }
    try {
      await page.locator(STEP1_SELECTORS['caseTypeLaunch']).first().click();
      await page.waitForSelector('.modal.in table tbody tr[data-id]', { timeout: 20_000 });
      r.notes.push(`lookup rows: ${await page.locator('.modal.in table tbody tr[data-id]').count()}`);
      await page.locator('.modal.in .cancel.btn, .modal.in button[aria-label="Cancel"]').first().click().catch(() => {});
    } catch { r.missing.push('step1.lookupModalRows'); }
    r.timings.wizardMs = Date.now() - t2;

    await page.goto(`${env.PORTAL_BASE_URL}/my-requests/`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (!(await page.waitForSelector('[role="grid"] [role="row"]', { timeout: 30_000 }).catch(() => null))) r.missing.push('myRequests.grid');

    r.ok = r.missing.length === 0 && !r.wafChallenge;
  } catch (e) {
    r.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  } finally {
    r.timings.totalMs = Date.now() - t0;
    await browser?.close().catch(() => {});
  }
  return r;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/canary') {
      if (request.headers.get('x-canary-token') !== env.CANARY_TOKEN) return new Response('unauthorized', { status: 401 });
      const report = await runCanary(env);
      return Response.json(report, { status: report.ok ? 200 : 500 });
    }
    return new Response('pvd311-worker spike', { status: 200 });
  },
} satisfies ExportedHandler<Env>;
