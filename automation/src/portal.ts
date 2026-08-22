import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { CATEGORIES, resolveField, type Report, type Category } from '../../shared/types.js';
import { scoutFields, type PortalControl } from './scout.js';

const PORTAL = config.portalBaseUrl;
const STEP_TIMEOUT = 45_000; // Portal postbacks observed at 5–18s

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_STATE_PATH = process.env['AUTH_STATE_PATH'] || join(__dirname, '..', '..', '..', '.auth-state.json');
const PROOF_DIR = process.env['PROOF_DIR'] || join(__dirname, '..', '..', '..', 'proofs');

export type SubmitMode = 'live' | 'inspect';

export interface SubmitOptions {
  /** 'live' submits; 'inspect' walks to Step 3, dumps the controls, screenshots, and stops (costs one draft). */
  mode?: SubmitMode;
  /** Called after each wizard step so the caller can persist draft bookkeeping (draft-resume on retry). */
  onDraft?: (draft: NonNullable<Report['portalDraft']>) => Promise<void>;
}

export interface SubmitResult {
  mode: SubmitMode;
  caseId?: string;
  proofPath?: string;
  /** Step-3 controls that were visible (inspect mode, or when the scout ran). */
  controls?: PortalControl[];
  /** Field values the scout proposed (if it ran). */
  scouted?: Record<string, string>;
}

export class PortalSubmitter {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private loggedIn = false;

  async launch(): Promise<void> {
    this.browser = await chromium.launch({
      headless: config.headless,
      args: ['--disable-dev-shm-usage'],
    });
    const contextOpts: Parameters<Browser['newContext']>[0] = {
      viewport: { width: 1280, height: 900 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    };
    if (existsSync(AUTH_STATE_PATH)) {
      contextOpts.storageState = AUTH_STATE_PATH;
      console.log('[portal] Restoring saved auth state');
    }
    this.context = await this.browser.newContext(contextOpts);
    this.page = await this.context.newPage();
  }

  async close(): Promise<void> {
    if (this.context && this.loggedIn) {
      try {
        await this.context.storageState({ path: AUTH_STATE_PATH });
        console.log('[portal] Auth state saved');
      } catch { /* non-fatal */ }
    }
    await this.browser?.close();
    this.browser = null;
    this.context = null;
    this.page = null;
    this.loggedIn = false;
  }

  private getPage(): Page {
    if (!this.page) throw new Error('Browser not launched');
    return this.page;
  }

  /** Read-only page access for the canary/watcher. Callers must never click Next/Submit. */
  pageForReadOnlyChecks(): Page {
    return this.getPage();
  }

  // ── Login ──────────────────────────────────────────────────

  async ensureLoggedIn(force = false): Promise<void> {
    const page = this.getPage();
    if (!force) {
      try {
        await page.goto(`${PORTAL}/my-requests/`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        if (await page.$('.username')) {
          console.log('[portal] Already logged in (reused session)');
          this.loggedIn = true;
          return;
        }
      } catch { /* fall through to login */ }
    }
    console.log('[portal] Logging in...');
    await page.goto(`${PORTAL}/SignIn?returnUrl=%2F`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.fill('#Username', config.portalEmail);
    await page.fill('#PasswordValue', config.portalPassword);
    await page.click('#submit-signin-local');
    await page.waitForURL('**/', { timeout: 20_000 });
    if (!(await page.$('.username'))) throw new Error('Portal login failed — no username element after sign-in');
    this.loggedIn = true;
    console.log('[portal] Logged in successfully');
  }

  /** True when the portal bounced us to the sign-in page mid-flow. */
  private async sessionLost(): Promise<boolean> {
    const page = this.getPage();
    return /\/SignIn/i.test(page.url());
  }

  // ── Submit a single report ─────────────────────────────────

  async submitReport(report: Report & { id: string }, opts: SubmitOptions = {}): Promise<SubmitResult> {
    await this.ensureLoggedIn();
    try {
      return await this.runWizard(report, opts);
    } catch (err) {
      // One re-auth retry if the session died mid-wizard
      if (await this.sessionLost()) {
        console.log('[portal] Session lost mid-wizard — re-authenticating and retrying once');
        await this.ensureLoggedIn(true);
        return await this.runWizard(report, opts);
      }
      throw err;
    }
  }

  private async runWizard(report: Report & { id: string }, opts: SubmitOptions): Promise<SubmitResult> {
    const page = this.getPage();
    const mode: SubmitMode = opts.mode ?? 'live';
    const cat = CATEGORIES[report.category];
    if (!cat) throw new Error(`Unknown category: ${report.category}`);

    console.log(`[portal] [${mode.toUpperCase()}] Report ${report.id}: ${cat.portalCaseTypeName} @ ${report.address}`);

    // Draft-resume: if a previous attempt already created the draft, jump back into it.
    let resumedAt: 2 | 3 | null = null;
    if (report.portalDraft?.url) {
      resumedAt = await this.tryResumeDraft(report.portalDraft);
      if (resumedAt) console.log(`[portal]   Resumed existing draft at step ${resumedAt}`);
      else console.log('[portal]   Could not resume saved draft — starting fresh');
    }

    if (!resumedAt) {
      await page.goto(`${PORTAL}/my-requests/New-Request/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForSelector('#casetypecode', { timeout: 20_000 });
      await this.fillStep1(report.category);
      await this.saveDraft(opts, 2);
    }
    if (!resumedAt || resumedAt === 2) {
      await this.fillStep2(report.address, report.lat, report.lng);
      await this.saveDraft(opts, 3);
    }
    return this.fillStep3(report, mode);
  }

  private async saveDraft(opts: SubmitOptions, step: 2 | 3): Promise<void> {
    if (!opts.onDraft) return;
    const page = this.getPage();
    const entityId = await page.$eval('#EntityFormView_EntityID', (el: any) => el.value as string).catch(() => null);
    await opts.onDraft({ url: page.url(), entityId: entityId || null, step, savedAt: new Date().toISOString() }).catch(() => {});
  }

  private async tryResumeDraft(draft: NonNullable<Report['portalDraft']>): Promise<2 | 3 | null> {
    const page = this.getPage();
    try {
      await page.goto(draft.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      if (await this.sessionLost()) return null;
      if (draft.step === 2 && (await page.$('#addressIn'))) return 2;
      if (draft.step === 3 && (await page.$('#description'))) return 3;
    } catch { /* fall through */ }
    return null;
  }

  // ── Step 1 ─────────────────────────────────────────────────

  private async fillStep1(category: Category): Promise<void> {
    const page = this.getPage();
    const cat = CATEGORIES[category];
    console.log('[portal]   Step 1: request type + case type...');

    await page.selectOption('#casetypecode', cat.requestType ?? '2'); // Problem
    await page.waitForTimeout(400);

    // Open the case-type lookup. The aria-label drifted once already ("Case Type" → "Choose an Issue (Case Type)"), so match loosely.
    const launch = page.locator('button[aria-label*="Case Type" i][aria-label*="lookup modal" i]').first();
    await launch.click();
    await page.waitForSelector('.modal.in .query.form-control', { timeout: 15_000 });
    await page.waitForTimeout(400);

    // Narrow the (13-page) list with a wildcard search, then select by GUID — never by text.
    const searchInput = page.locator('.modal.in .query.form-control');
    await searchInput.clear();
    await searchInput.pressSequentially(cat.portalSearchTerm, { delay: 60 });
    await page.click('.modal.in button[aria-label="Search Results"]');
    await page.waitForTimeout(1_200);

    let row = page.locator(`.modal.in table tbody tr[data-id="${cat.portalCaseTypeGuid}"]`).first();
    if (!(await row.isVisible().catch(() => false))) {
      // Fallback: search by the exact name
      await searchInput.clear();
      await searchInput.pressSequentially(cat.portalCaseTypeName, { delay: 40 });
      await page.click('.modal.in button[aria-label="Search Results"]');
      await page.waitForTimeout(1_200);
      row = page.locator(`.modal.in table tbody tr[data-id="${cat.portalCaseTypeGuid}"]`).first();
    }
    await row.waitFor({ timeout: 10_000 }).catch(() => {
      throw new Error(`Case type GUID ${cat.portalCaseTypeGuid} ("${cat.portalCaseTypeName}") not found in lookup — census may be stale`);
    });
    console.log(`[portal]   Case type: "${(await row.getAttribute('data-name')) ?? cat.portalCaseTypeName}"`);
    await row.locator('span[role="checkbox"]').click();
    await page.waitForTimeout(300);
    await page.locator('.modal.in .primary.btn.btn-primary, .modal.in button[aria-label="Select"]').first().click();
    await page.waitForSelector('.modal.in', { state: 'detached', timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(400);

    // How the city should send updates. '585680003' = No Contact Necessary (until the relay inbox exists).
    await page.selectOption('#cop_methodofupdate', config.portalNotificationMethod);

    await page.click('#NextButton');
    await page.waitForURL(/stepid/, { timeout: STEP_TIMEOUT });
    console.log('[portal]   Step 1 complete (draft created)');
  }

  // ── Step 2 ─────────────────────────────────────────────────

  private async fillStep2(address: string, lat: number | null, lng: number | null): Promise<void> {
    const page = this.getPage();
    console.log('[portal]   Step 2: location...');
    await page.waitForSelector('#addressIn', { timeout: 20_000 });

    if (lat && lng) {
      const arcgisAddr = await this.arcgisReverseGeocode(lat, lng);
      if (arcgisAddr) {
        console.log(`[portal]   ArcGIS resolved: ${arcgisAddr.street}, ${arcgisAddr.city} ${arcgisAddr.zip}`);
        await page.fill('#addressIn', arcgisAddr.full);
        await page.evaluate((a) => {
          const set = (id: string, val: string) => {
            const el = document.getElementById(id) as HTMLInputElement | null;
            if (el) el.value = val;
          };
          set('cop_address', JSON.stringify(a.full));
          set('cop_street1', a.street);
          set('cop_city', a.city);
          set('cop_stateorprovidence', a.state);
          set('cop_zipofpostalcode', a.zip);
          set('cop_countryorregion', a.country);
          set('cop_latitude', a.lat);
          set('cop_longitude', a.lng);
        }, arcgisAddr);
      } else {
        console.log('[portal]   ArcGIS reverse geocode failed, falling back to autocomplete');
        await this.fillStep2Autocomplete(address);
      }
    } else {
      await this.fillStep2Autocomplete(address);
    }

    const before = page.url();
    await page.click('#NextButton');
    await page.waitForFunction((u) => location.href !== u, before, { timeout: STEP_TIMEOUT });
    await page.waitForSelector('#description', { timeout: 20_000 });
    console.log('[portal]   Step 2 complete');
  }

  private async fillStep2Autocomplete(address: string): Promise<void> {
    const page = this.getPage();
    await page.locator('#addressIn').pressSequentially(address, { delay: 50 });
    await page.waitForSelector('tr.suggestRow', { timeout: 10_000 });
    await page.click('tr.suggestRow td.suggestData');
    await page.waitForTimeout(1_000);
  }

  private async arcgisReverseGeocode(lat: number, lng: number): Promise<{
    full: string; street: string; city: string; state: string; zip: string; country: string; lat: string; lng: string;
  } | null> {
    try {
      const url = `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode?location=${lng},${lat}&featureTypes=StreetAddress,StreetName,StreetInt&f=pjson`;
      const resp = await fetch(url);
      const data = await resp.json();
      if (!data.address) return null;
      const a = data.address;
      return {
        full: a.LongLabel || a.Match_addr || `${a.Address}, ${a.City}, ${a.RegionAbbr}, ${a.Postal}, USA`,
        street: a.Address || a.ShortLabel || '',
        city: a.City || 'Providence',
        state: a.RegionAbbr || 'RI',
        zip: a.Postal || '',
        country: a.CountryCode || 'USA',
        lat: String(lat),
        lng: String(lng),
      };
    } catch (err) {
      console.error('[portal]   ArcGIS reverse geocode error:', err);
      return null;
    }
  }

  // ── Step 3 ─────────────────────────────────────────────────

  /** Dump the visible, fillable Step-3 controls (excluding the always-present description/address/case-type). */
  private async dumpControls(): Promise<PortalControl[]> {
    const page = this.getPage();
    return page.evaluate(() => {
      const SKIP = new Set(['cop_casetype_name', 'cop_address', 'description', 'PreviousButton', 'NextButton', 'AttachFile']);
      const out: any[] = [];
      document.querySelectorAll('select, input, textarea').forEach((el: any) => {
        if (!el.offsetParent) return;                       // hidden
        if (!el.id || SKIP.has(el.id)) return;
        if (el.type === 'hidden' || el.type === 'button' || el.type === 'submit' || el.type === 'file') return;
        const label = el.getAttribute('aria-label')
          || document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim().replace(/\s+/g, ' ')
          || el.id;
        if (/leave this field blank/i.test(label) || /^frm_pref_/.test(el.id)) return; // honeypot — never touch
        if (el.type === 'radio') {
          // Collapse a radio group into one control keyed by its group name (e.g. cop_cartrequesttype)
          const key = el.name.split('$').pop() || el.name;
          let g = out.find((x) => x.type === 'radio' && x.name === el.name);
          if (!g) { g = { id: key, label: label.replace(/\s+.*$/, '') || key, tag: 'input', type: 'radio', name: el.name, required: !!el.required, options: [] }; out.push(g); }
          g.options.push(label.replace(new RegExp('^' + g.label + '\\s*'), '').trim() || label);
          return;
        }
        const c: any = { id: el.id, label, tag: el.tagName.toLowerCase(), type: el.type || null, required: !!el.required || el.getAttribute('aria-required') === 'true' };
        if (el.tagName === 'SELECT') c.options = Array.from(el.options).map((o: any) => o.textContent.trim()).filter((t: string) => t && t !== 'Select');
        out.push(c);
      });
      return out;
    });
  }

  private async setControl(c: PortalControl, value: string): Promise<void> {
    const page = this.getPage();
    const sel = `#${c.id}`;
    if (c.tag === 'select') {
      await page.selectOption(sel, { label: value }).catch(async () => page.selectOption(sel, value));
    } else if (c.type === 'radio') {
      const radios = page.locator(`input[type="radio"][name="${c.name}"]`);
      const n = await radios.count();
      for (let i = 0; i < n; i++) {
        const r = radios.nth(i);
        const lab = (await r.getAttribute('aria-label')) || '';
        if (lab.toLowerCase().includes(value.toLowerCase())) { await r.check(); await r.dispatchEvent('change').catch(() => {}); return; }
      }
      await radios.last().check(); // last option is conventionally "Other"
      return;
    } else if (c.type === 'checkbox') {
      if (/^(yes|true|1|on)$/i.test(value)) await page.check(sel); else await page.uncheck(sel);
    } else {
      await page.fill(sel, value);
    }
    // The portal marks fields dirty via onchange; make sure it fires.
    await page.dispatchEvent(sel, 'change').catch(() => {});
  }

  private async fillStep3(report: Report & { id: string }, mode: SubmitMode): Promise<SubmitResult> {
    const page = this.getPage();
    const cat = CATEGORIES[report.category];
    console.log('[portal]   Step 3: details...');

    // Description
    const descParts: string[] = [];
    if (report.description) descParts.push(report.description);
    if (report.lat && report.lng) {
      descParts.push(`Exact location: https://maps.google.com/?q=${report.lat.toFixed(6)},${report.lng.toFixed(6)}`);
    }
    descParts.push(`[Submitted via ${config.appName} — ref:${report.id}]`);
    await page.fill('#description', descParts.join('\n\n'));

    // Conditional fields: known mappings first, then the agent scout for anything left visible.
    const controls = await this.dumpControls();
    const filled: Record<string, string> = {};
    const unmapped: PortalControl[] = [];
    for (const c of controls) {
      const src = cat.fields?.[c.id];
      const v = src ? resolveField(src, report as unknown as Record<string, unknown>) : undefined;
      if (v !== undefined) { await this.setControl(c, v); filled[c.id] = v; }
      else unmapped.push(c);
    }
    if (Object.keys(filled).length) console.log(`[portal]   Filled mapped fields: ${JSON.stringify(filled)}`);

    let scouted: Record<string, string> | undefined;
    // Scout runs in live mode, and in inspect mode when a key is configured (so new categories can be previewed without submitting).
    if (unmapped.length && (mode === 'live' || process.env['ANTHROPIC_API_KEY'])) {
      console.log(`[portal]   ${unmapped.length} unmapped control(s): ${unmapped.map((c) => c.id).join(', ')} — calling scout`);
      const result = await scoutFields({ category: report.category, caseTypeName: cat.portalCaseTypeName, report, controls: unmapped });
      scouted = result.values;
      for (const c of unmapped) {
        const v = scouted[c.id];
        if (v !== undefined) await this.setControl(c, v);
      }
      console.log(`[portal]   Scout filled: ${JSON.stringify(scouted)} (confidence ${result.confidence})`);
      if (result.confidence < config.scoutMinConfidence && mode === 'live') {
        throw new Error(`NEEDS_REVIEW: scout confidence ${result.confidence} below ${config.scoutMinConfidence} for ${unmapped.map((c) => c.id).join(', ')} — ${result.notes}`);
      }
    }

    if (report.photo) await this.uploadPhoto(report.photo);

    if (mode === 'inspect') {
      const proofPath = await this.screenshot(report.id, 'inspect');
      console.log(`[portal]   INSPECT — stopping before submit. Controls: ${controls.map((c) => c.id).join(', ') || '(none)'}`);
      return { mode, controls, proofPath, scouted };
    }

    // Submit, distinguishing validation failure (button stays "Submit") from a slow postback ("Processing...").
    const navPromise = page.waitForURL(/my-requests|New-Request/, { timeout: 60_000 });
    await page.click('#NextButton', { timeout: 10_000 });
    await Promise.race([
      navPromise.then(() => 'navigated' as const),
      page.waitForTimeout(5_000).then(async () => {
        const btnValue = await page.$eval('#NextButton', (el: any) => el.value).catch(() => '');
        if (btnValue === 'Processing...') { await navPromise; return 'navigated' as const; }
        const errorText = await page.$eval('.validation-summary-errors', (el: any) => el.textContent?.trim()).catch(() => '');
        throw new Error(`Portal form validation failed${errorText ? ': ' + errorText : ' (button still shows "Submit")'}`);
      }),
    ]);
    console.log('[portal]   Step 3 complete — report submitted');

    const caseId = await this.extractCaseId();
    const proofPath = await this.screenshot(report.id, caseId ?? 'submitted');
    return { mode, caseId, proofPath, controls, scouted };
  }

  // ── Proof ──────────────────────────────────────────────────

  private async screenshot(reportId: string, tag: string): Promise<string | undefined> {
    try {
      mkdirSync(PROOF_DIR, { recursive: true });
      const p = join(PROOF_DIR, `${reportId}-${tag}-${Date.now()}.png`);
      await this.getPage().screenshot({ path: p, fullPage: true });
      return p;
    } catch { return undefined; }
  }

  // ── Photo upload ───────────────────────────────────────────

  private async uploadPhoto(photoSource: string): Promise<void> {
    const page = this.getPage();
    try {
      const tmpDir = join(tmpdir(), 'pvd311-photos');
      mkdirSync(tmpDir, { recursive: true });
      let tmpPath: string;
      if (photoSource.startsWith('data:')) {
        const matches = photoSource.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!matches) { console.log('[portal]   Skipping photo — invalid data URL'); return; }
        const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
        tmpPath = join(tmpDir, `report-photo.${ext}`);
        writeFileSync(tmpPath, Buffer.from(matches[2], 'base64'));
      } else {
        const resp = await fetch(photoSource);
        if (!resp.ok) { console.log(`[portal]   Skipping photo — fetch failed (${resp.status})`); return; }
        tmpPath = join(tmpDir, 'report-photo.jpg');
        writeFileSync(tmpPath, Buffer.from(await resp.arrayBuffer()));
      }
      await page.setInputFiles('#AttachFile', tmpPath);
      await page.evaluate(() => {
        if (typeof (window as any).chooseAttachment === 'function') (window as any).chooseAttachment();
      });
      await page.waitForTimeout(500);
      console.log('[portal]   Photo uploaded');
    } catch (err) {
      console.error('[portal]   Photo upload failed (non-fatal):', err);
    }
  }

  // ── Case ID extraction ─────────────────────────────────────

  private async extractCaseId(): Promise<string | undefined> {
    const page = this.getPage();
    try {
      await page.goto(`${PORTAL}/my-requests/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForSelector('[role="grid"] [role="row"]', { timeout: 30_000 });
      await page.waitForTimeout(3_000); // lazy grid
      // Newest case is the first data row; its title cell reads "PVD2026-12345 <Case Type Name>".
      const text = await page.locator('[role="grid"] [role="row"]').nth(1).textContent();
      const m = text?.match(/PVD\d{4}-\d+/);
      if (m) { console.log(`[portal]   Case ID: ${m[0]}`); return m[0]; }
    } catch { /* non-fatal */ }
    console.log('[portal]   Could not extract case ID (non-fatal)');
    return undefined;
  }
}
