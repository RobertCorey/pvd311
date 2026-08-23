/**
 * portal.ts — the Providence 311 wizard driver, ported to Cloudflare Browser Run
 * (@cloudflare/playwright). One instance per cron tick; always close().
 *
 * Faithful port of automation/src/portal.ts (submit wizard), automation/src/canary.ts
 * (zero-draft selector canary) and the read-only My Requests scrape from
 * automation/src/watcher.ts. Differences forced by the Workers runtime:
 *   - No fs/os/tmpdir: photos are fetched into a buffer and pushed via setInputFiles({buffer}).
 *   - No process.env: all config comes from `env` / module constants.
 *   - Auth state (Playwright storageState) is persisted through the injected AuthStore,
 *     not a JSON file on disk.
 *   - Proof screenshots are handed to opts.saveProof(name, png) instead of written to a PROOF_DIR.
 *
 * `document` / `window` / `location` below are the browser-page globals referenced inside
 * page.evaluate()/waitForFunction() callbacks. The Worker's tsconfig has no DOM lib, so they are
 * declared as ambient `any` purely for type-checking; the declarations are erased at build and the
 * identifiers resolve to the real browser globals when the serialized callback runs in the page.
 */
import { launch, type Browser, type BrowserContext, type Page } from '@cloudflare/playwright';
import { CATEGORIES, resolveField } from '../../shared/categories.js';
import type {
  AuthStore,
  Env,
  Portal,
  PortalDraft,
  ReportDoc,
  SubmitMode,
  SubmitOptions,
  SubmitResult,
} from './contracts.js';
import { scoutFields as defaultScoutFields, type PortalControl } from './scout.js';

declare const document: any;
declare const window: any;
declare const location: any;

const STEP_TIMEOUT = 45_000; // Portal postbacks observed at 5–18s; wizard+modal measured ~37s in the spike.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
/** How the city should send updates. '585680003' = No Contact Necessary (until the relay inbox exists). */
const NOTIFICATION_METHOD = '585680003';
/** Scout confidence below this parks the report for review (NEEDS_REVIEW). */
const SCOUT_MIN_CONFIDENCE = 0.7;

const STEP1_SELECTORS: Record<string, string> = {
  requestType: '#casetypecode',
  caseTypeLaunch: 'button[aria-label*="Case Type" i][aria-label*="lookup modal" i]',
  notificationMethod: '#cop_methodofupdate',
  nextButton: '#NextButton',
  honeypot: 'input[id^="frm_pref_"]',
};

type StorageStateOpt = NonNullable<Parameters<Browser['newContext']>[0]>['storageState'];
type SetInputFilesArg = Parameters<Page['setInputFiles']>[1];

export interface PortalDeps {
  auth: AuthStore;
  scout?: typeof defaultScoutFields;
}

export function createPortal(env: Env, deps: PortalDeps): Portal {
  return new WorkerPortal(env, deps);
}

class WorkerPortal implements Portal {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private loggedIn = false;

  constructor(private readonly env: Env, private readonly deps: PortalDeps) {}

  private get portal(): string {
    return this.env.PORTAL_BASE_URL;
  }

  async launch(): Promise<void> {
    this.browser = await launch(this.env.BROWSER);
    const state = await this.deps.auth.load();
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: UA,
      ...(state ? { storageState: state as StorageStateOpt } : {}),
    });
    this.page = await this.context.newPage();
  }

  async close(): Promise<void> {
    // Only persist storage state if we actually logged in, mirroring the Node submitter.
    if (this.context && this.loggedIn) {
      try {
        const state = await this.context.storageState();
        await this.deps.auth.save(state as unknown as Record<string, unknown>);
      } catch {
        /* non-fatal */
      }
    }
    await this.browser?.close().catch(() => {});
    this.browser = null;
    this.context = null;
    this.page = null;
    this.loggedIn = false;
  }

  private getPage(): Page {
    if (!this.page) throw new Error('Browser not launched');
    return this.page;
  }

  // ── Login ──────────────────────────────────────────────────

  async ensureLoggedIn(force = false): Promise<void> {
    const page = this.getPage();
    if (!force) {
      try {
        await page.goto(`${this.portal}/my-requests/`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        if (await page.$('.username')) {
          this.loggedIn = true;
          return;
        }
      } catch {
        /* fall through to login */
      }
    }
    await page.goto(`${this.portal}/SignIn?returnUrl=%2F`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.fill('#Username', this.env.PORTAL_EMAIL);
    await page.fill('#PasswordValue', this.env.PORTAL_PASSWORD);
    await page.click('#submit-signin-local');
    await page.waitForURL('**/', { timeout: 20_000 });
    if (!(await page.$('.username'))) throw new Error('Portal login failed — no username element after sign-in');
    this.loggedIn = true;
  }

  /** True when the portal bounced us to the sign-in page mid-flow. */
  private async sessionLost(): Promise<boolean> {
    return /\/SignIn/i.test(this.getPage().url());
  }

  // ── Submit a single report ─────────────────────────────────

  async submitReport(report: ReportDoc, opts: SubmitOptions = {}): Promise<SubmitResult> {
    await this.ensureLoggedIn();
    try {
      return await this.runWizard(report, opts);
    } catch (err) {
      // One re-auth retry if the session died mid-wizard.
      if (await this.sessionLost()) {
        await this.ensureLoggedIn(true);
        return await this.runWizard(report, opts);
      }
      throw err;
    }
  }

  private async runWizard(report: ReportDoc, opts: SubmitOptions): Promise<SubmitResult> {
    const page = this.getPage();
    const mode: SubmitMode = opts.mode ?? 'live';
    const cat = CATEGORIES[report.category];
    if (!cat) throw new Error(`Unknown category: ${report.category}`);

    // Check-before-create: a previous attempt may have SUBMITTED the draft and died before we recorded it
    // (timeout after the final click, reaper, retry). The draft's GUID is the record's GUID, so if My
    // Requests shows it with a real status, it's already filed — never run the wizard again for it.
    if (report.portalDraft?.caseId && mode === 'live') {
      const row = await this.findMyRequestByCaseId(report.portalDraft.caseId, 3).catch(() => null);
      if (row && row.status && !/^draft$/i.test(row.status)) {
        const proofPath = await this.saveProof(opts, report.id, row.caseId ?? 'already-filed');
        return { mode, caseId: row.caseId ?? undefined, proofPath, entityId: report.portalDraft.entityId ?? undefined, caseIdConfirmed: true, alreadyFiled: true, caseIdCandidate: report.portalDraft.caseId };
      }
    }

    // Draft-resume: if a previous attempt already created the draft, jump back into it.
    let resumedAt: 2 | 3 | null = null;
    if (report.portalDraft?.url) {
      resumedAt = await this.tryResumeDraft(report.portalDraft);
    }

    if (!resumedAt) {
      await page.goto(`${this.portal}/my-requests/New-Request/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForSelector('#casetypecode', { timeout: 20_000 });
      await this.fillStep1(report.category);
      await this.saveDraft(opts, 2);
    }
    if (!resumedAt || resumedAt === 2) {
      await this.fillStep2(report.address, report.lat, report.lng);
      await this.saveDraft(opts, 3);
    }
    return this.fillStep3(report, mode, opts);
  }

  private async saveDraft(opts: SubmitOptions, step: 2 | 3): Promise<void> {
    if (!opts.onDraft) return;
    const page = this.getPage();
    const entityId = await page
      .$eval('#EntityFormView_EntityID', (el: any) => el.value as string)
      .catch(() => null);
    const caseId = await this.readDraftCaseId(entityId || null);
    const draft: PortalDraft = { url: page.url(), entityId: entityId || null, step, savedAt: new Date().toISOString(), caseId };
    await opts.onDraft(draft).catch(() => {});
  }

  /**
   * The portal assigns the PVD number when the draft is created. The running New-Request wizard does not
   * show it, but Edit-Request/?id=<GUID> does (input#title = "PVD2026-87687 Pothole Report"). Read it from a
   * side tab so the wizard page is untouched. Read-only; creates nothing.
   */
  private async readDraftCaseId(entityId: string | null): Promise<string | null> {
    const page = this.getPage();
    const fromInputs = () => Array.from(document.querySelectorAll('input')).map((i) => /PVD\d{4}-\d+/.exec((i as any).value || '')?.[0] ?? null).find(Boolean) ?? null;
    const inPage = await page.evaluate(fromInputs).catch(() => null);
    if (inPage) return inPage;
    if (!entityId || !this.context) return null;
    const side = await this.context.newPage();
    try {
      await side.goto(`${this.portal}/my-requests/Edit-Request/?id=${encodeURIComponent(entityId)}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await side.waitForSelector('input#title, input[name="title"]', { timeout: 15_000 }).catch(() => {});
      return (await side.evaluate(fromInputs).catch(() => null)) ?? null;
    } catch {
      return null;
    } finally {
      await side.close().catch(() => {});
    }
  }

  private async tryResumeDraft(draft: PortalDraft): Promise<2 | 3 | null> {
    const page = this.getPage();
    try {
      await page.goto(draft.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      if (await this.sessionLost()) return null;
      if (draft.step === 2 && (await page.$('#addressIn'))) return 2;
      if (draft.step === 3 && (await page.$('#description'))) return 3;
    } catch {
      /* fall through */
    }
    return null;
  }

  // ── Step 1 ─────────────────────────────────────────────────

  private async fillStep1(category: string): Promise<void> {
    const page = this.getPage();
    const cat = CATEGORIES[category];
    if (!cat) throw new Error(`Unknown category: ${category}`);

    await page.selectOption('#casetypecode', cat.requestType ?? '2'); // Problem
    await page.waitForTimeout(400);

    // Open the case-type lookup. The aria-label drifted once already ("Case Type" → "Choose an Issue
    // (Case Type)"), so match loosely.
    const launchBtn = page.locator('button[aria-label*="Case Type" i][aria-label*="lookup modal" i]').first();
    await launchBtn.click();
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
      // Fallback: search by the exact name.
      await searchInput.clear();
      await searchInput.pressSequentially(cat.portalCaseTypeName, { delay: 40 });
      await page.click('.modal.in button[aria-label="Search Results"]');
      await page.waitForTimeout(1_200);
      row = page.locator(`.modal.in table tbody tr[data-id="${cat.portalCaseTypeGuid}"]`).first();
    }
    await row.waitFor({ timeout: 10_000 }).catch(() => {
      throw new Error(
        `Case type GUID ${cat.portalCaseTypeGuid} ("${cat.portalCaseTypeName}") not found in lookup — census may be stale`,
      );
    });
    await row.locator('span[role="checkbox"]').click();
    await page.waitForTimeout(300);
    await page
      .locator('.modal.in .primary.btn.btn-primary, .modal.in button[aria-label="Select"]')
      .first()
      .click();
    await page.waitForSelector('.modal.in', { state: 'detached', timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(400);

    await page.selectOption('#cop_methodofupdate', NOTIFICATION_METHOD);

    await page.click('#NextButton');
    await page.waitForURL(/stepid/, { timeout: STEP_TIMEOUT });
  }

  // ── Step 2 ─────────────────────────────────────────────────

  private async fillStep2(address: string, lat: number | null, lng: number | null): Promise<void> {
    const page = this.getPage();
    await page.waitForSelector('#addressIn', { timeout: 20_000 });

    if (lat && lng) {
      const arcgisAddr = await this.arcgisReverseGeocode(lat, lng);
      if (arcgisAddr) {
        await page.fill('#addressIn', arcgisAddr.full);
        await page.evaluate((a) => {
          const set = (id: string, val: string) => {
            const el = document.getElementById(id);
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
        await this.fillStep2Autocomplete(address);
      }
    } else {
      await this.fillStep2Autocomplete(address);
    }

    const before = page.url();
    await page.click('#NextButton');
    await page.waitForFunction((u) => location.href !== u, before, { timeout: STEP_TIMEOUT });
    await page.waitForSelector('#description', { timeout: 20_000 });
  }

  private async fillStep2Autocomplete(address: string): Promise<void> {
    const page = this.getPage();
    await page.locator('#addressIn').pressSequentially(address, { delay: 50 });
    await page.waitForSelector('tr.suggestRow', { timeout: 10_000 });
    await page.click('tr.suggestRow td.suggestData');
    await page.waitForTimeout(1_000);
  }

  private async arcgisReverseGeocode(
    lat: number,
    lng: number,
  ): Promise<{
    full: string;
    street: string;
    city: string;
    state: string;
    zip: string;
    country: string;
    lat: string;
    lng: string;
  } | null> {
    try {
      const url = `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode?location=${lng},${lat}&featureTypes=StreetAddress,StreetName,StreetInt&f=pjson`;
      const resp = await fetch(url);
      const data = (await resp.json()) as any;
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
    } catch {
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
        if (!el.offsetParent) return; // hidden
        if (!el.id || SKIP.has(el.id)) return;
        if (el.type === 'hidden' || el.type === 'button' || el.type === 'submit' || el.type === 'file') return;
        const label =
          el.getAttribute('aria-label') ||
          document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim().replace(/\s+/g, ' ') ||
          el.id;
        if (/leave this field blank/i.test(label) || /^frm_pref_/.test(el.id)) return; // honeypot — never touch
        if (el.type === 'radio') {
          // Collapse a radio group into one control keyed by its group name (e.g. cop_cartrequesttype).
          const key = el.name.split('$').pop() || el.name;
          let g = out.find((x) => x.type === 'radio' && x.name === el.name);
          if (!g) {
            g = { id: key, label: label.replace(/\s+.*$/, '') || key, tag: 'input', type: 'radio', name: el.name, required: !!el.required, options: [] };
            out.push(g);
          }
          g.options.push(label.startsWith(g.label) ? label.slice(g.label.length).trim() || label : label);
          return;
        }
        const c: any = {
          id: el.id,
          label,
          tag: el.tagName.toLowerCase(),
          type: el.type || null,
          required: !!el.required || el.getAttribute('aria-required') === 'true',
        };
        if (el.tagName === 'SELECT')
          c.options = Array.from(el.options)
            .map((o: any) => o.textContent.trim())
            .filter((t: string) => t && t !== 'Select');
        out.push(c);
      });
      return out as PortalControl[];
    });
  }

  private async setControl(c: PortalControl, value: string): Promise<void> {
    const page = this.getPage();
    const sel = `#${c.id}`;
    if (c.tag === 'select') {
      await page.selectOption(sel, { label: value }).catch(async () => {
        await page.selectOption(sel, value);
      });
    } else if (c.type === 'radio') {
      const radios = page.locator(`input[type="radio"][name="${c.name}"]`);
      const n = await radios.count();
      const want = value.trim().toLowerCase();
      for (let i = 0; i < n; i++) {
        const r = radios.nth(i);
        const lab = ((await r.getAttribute('aria-label')) || '').trim().toLowerCase();
        // exact option text, or "<group label> <option text>" as the portal composes aria-labels
        if (lab === want || lab.endsWith(' ' + want) || (c.label && lab === `${c.label.toLowerCase()} ${want}`)) {
          await r.check();
          await r.dispatchEvent('change').catch(() => {});
          return;
        }
      }
      throw new Error(`NEEDS_REVIEW: no radio option matches "${value}" for ${c.id} (options: ${(c.options ?? []).join(' | ')})`);
    } else if (c.type === 'checkbox') {
      if (/^(yes|true|1|on)$/i.test(value)) await page.check(sel);
      else await page.uncheck(sel);
    } else {
      await page.fill(sel, value);
    }
    // The portal marks fields dirty via onchange; make sure it fires.
    await page.dispatchEvent(sel, 'change').catch(() => {});
  }

  private async fillStep3(report: ReportDoc, mode: SubmitMode, opts: SubmitOptions): Promise<SubmitResult> {
    const page = this.getPage();
    const cat = CATEGORIES[report.category];
    if (!cat) throw new Error(`Unknown category: ${report.category}`);

    // Description
    const descParts: string[] = [];
    if (report.description) descParts.push(report.description);
    if (report.lat && report.lng) {
      descParts.push(`Exact location: https://maps.google.com/?q=${report.lat.toFixed(6)},${report.lng.toFixed(6)}`);
    }
    descParts.push(`[Submitted via ${this.env.APP_NAME} — ref:${report.id}]`);
    await page.fill('#description', descParts.join('\n\n'));

    // Conditional fields: known mappings first, then the agent scout for anything left visible.
    const controls = await this.dumpControls();
    const filled: Record<string, string> = {};
    const unmapped: PortalControl[] = [];
    for (const c of controls) {
      const src = cat.fields?.[c.id];
      const v = src ? resolveField(src, report as unknown as Record<string, unknown>) : undefined;
      if (v !== undefined) {
        await this.setControl(c, v);
        filled[c.id] = v;
      } else {
        unmapped.push(c);
      }
    }

    let scouted: Record<string, string> | undefined;
    if (unmapped.length && mode === 'live') {
      const scout = this.deps.scout ?? defaultScoutFields;
      const result = await scout({
        apiKey: this.env.ANTHROPIC_API_KEY,
        category: report.category,
        caseTypeName: cat.portalCaseTypeName,
        report,
        controls: unmapped,
      });
      scouted = result.values;
      for (const c of unmapped) {
        const v = scouted[c.id];
        if (v !== undefined) await this.setControl(c, v);
      }
      if (result.confidence < SCOUT_MIN_CONFIDENCE) {
        throw new Error(
          `NEEDS_REVIEW: scout confidence ${result.confidence} below ${SCOUT_MIN_CONFIDENCE} for ` +
            `${unmapped.map((c) => c.id).join(', ')} — ${result.notes}`,
        );
      }
    }

    // Capture the PVD number from the wizard BEFORE submitting (also in inspect mode, so the capture path is exercised without a submit) (input#title carries it once the draft exists).
    if (!report.portalDraft?.caseId) {
      const eid = report.portalDraft?.entityId ?? (await page.$eval('#EntityFormView_EntityID', (el: any) => el.value as string).catch(() => null)) ?? null;
      const fromPage = await this.readDraftCaseId(eid);
      if (fromPage) {
        report.portalDraft = { ...(report.portalDraft ?? { url: page.url(), entityId: null, step: 3, savedAt: new Date().toISOString() }), caseId: fromPage };
        if (opts.onDraft) await opts.onDraft(report.portalDraft).catch(() => {});
      }
    }

    if (report.photo) await this.uploadPhoto(report.photo);

    if (mode === 'inspect') {
      const proofPath = await this.saveProof(opts, report.id, 'inspect');
      return { mode, controls, proofPath, scouted };
    }

    // Submit, distinguishing validation failure (button stays "Submit") from a slow postback ("Processing...").
    const before = page.url();
    const navPromise = page.waitForFunction((u) => location.href !== u, before, { timeout: 60_000 }).then(() => undefined);
    await page.click('#NextButton', { timeout: 10_000 });
    await Promise.race([
      navPromise.then(() => 'navigated' as const),
      page.waitForTimeout(5_000).then(async () => {
        const btnValue = await page.$eval('#NextButton', (el: any) => el.value).catch(() => '');
        if (btnValue === 'Processing...') {
          await navPromise;
          return 'navigated' as const;
        }
        const errorText = await page
          .$eval('.validation-summary-errors', (el: any) => el.textContent?.trim())
          .catch(() => '');
        throw new Error(
          `Portal form validation failed${errorText ? ': ' + errorText : ' (button still shows "Submit")'}`,
        );
      }),
    ]);

    const entityId = report.portalDraft?.entityId ?? null;
    const candidate = report.portalDraft?.caseId ?? null;
    const caseId = await this.extractCaseId(candidate);
    const proofPath = await this.saveProof(opts, report.id, caseId ?? 'submitted');
    return { mode, caseId, proofPath, controls, scouted, entityId: entityId ?? undefined, caseIdConfirmed: !!caseId, caseIdCandidate: candidate ?? undefined };
  }

  // ── Proof ──────────────────────────────────────────────────

  private async saveProof(opts: SubmitOptions, reportId: string, tag: string): Promise<string | undefined> {
    if (!opts.saveProof) return undefined;
    try {
      // JPEG of the viewport (not full page): Firestore docs cap at 1 MiB and the receipt is what matters.
      const jpg = await this.getPage().screenshot({ type: 'jpeg', quality: 60 });
      const name = `${tag}-${Date.now()}`.replace(/[^A-Za-z0-9_-]/g, '_');
      const res = await opts.saveProof(name, jpg);
      return typeof res === 'string' ? res : undefined;
    } catch (e) {
      console.error(`[portal] proof save failed for ${reportId} (${tag}):`, e instanceof Error ? e.message : e);
      return undefined;
    }
  }

  // ── Photo upload ───────────────────────────────────────────

  private async uploadPhoto(photoSource: string): Promise<void> {
    const page = this.getPage();
    try {
      let name = 'report-photo.jpg';
      let mimeType = 'image/jpeg';
      let buffer: unknown;

      if (photoSource.startsWith('data:')) {
        const matches = photoSource.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!matches) return; // invalid data URL — skip photo
        const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
        name = `report-photo.${ext}`;
        mimeType = `image/${matches[1]}`;
        buffer = nodeBufferFrom(matches[2], 'base64');
      } else {
        const resp = await fetch(photoSource);
        if (!resp.ok) return; // fetch failed — skip photo
        mimeType = resp.headers.get('content-type') || 'image/jpeg';
        buffer = nodeBufferFrom(new Uint8Array(await resp.arrayBuffer()));
      }

      await page.setInputFiles('#AttachFile', { name, mimeType, buffer } as unknown as SetInputFilesArg);
      // The portal stages the chosen file via a page hook before the postback picks it up.
      await page.evaluate(() => {
        if (typeof window.chooseAttachment === 'function') window.chooseAttachment();
      });
      await page.waitForTimeout(500);
    } catch {
      /* non-fatal: submit without the photo rather than fail the whole report */
    }
  }

  // ── Case ID extraction ─────────────────────────────────────

  /**
   * Case number after submit. Order of trust: (1) the page the wizard landed on (confirmation / record view
   * often prints "PVD2026-12345"); (2) the My Requests row whose data-id equals OUR draft's entity GUID —
   * never "the first row" (another submission, or a grid re-sort, makes that wrong); (3) nothing → the
   * engine records the submission as unconfirmed and the watcher resolves it later by GUID.
   */
  private async extractCaseId(candidate: string | null): Promise<string | undefined> {
    const page = this.getPage();
    try {
      if (candidate) {
        // We know the number; confirm the record left Draft. Exact row match — never "the first row".
        const row = await this.findMyRequestByCaseId(candidate, 3);
        if (row && row.status && !/^draft$/i.test(row.status)) return candidate;
        return undefined; // still Draft (or not visible yet) → engine records unconfirmed; watcher reconciles
      }
      const landing = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
      const onPage = landing.match(/PVD\d{4}-\d+/g) ?? [];
      if (onPage.length === 1) return onPage[0]; // legacy path: a single unambiguous id on the landing page
    } catch {
      /* non-fatal */
    }
    return undefined;
  }

  // ── Read-only: My Requests grid (watcher / canary) ─────────

  async readMyRequests(opts: { maxPages?: number } = {}): Promise<MyRequestRow[]> {
    const page = this.getPage();
    await page.goto(`${this.portal}/my-requests/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForSelector('[role="grid"] [role="row"], table tbody tr', { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(3_000); // lazy grid render

    const byId = new Map<string, MyRequestRow>();
    const MAX_PAGES = opts.maxPages ?? 20;
    for (let p = 0; p < MAX_PAGES; p++) {
      const { headers, rows, ids } = await this.dumpGrid();
      rows.forEach((row, i) => {
        const parsed = parseRow(headers, row);
        const entityId = ids[i];
        // Drafts have no PVD number yet: key them by GUID so check-before-create can still see them.
        const key = parsed?.caseId ?? (entityId ? `draft:${entityId}` : null);
        if (!key || byId.has(key)) return;
        byId.set(key, {
          caseId: parsed?.caseId ?? null,
          entityId,
          status: parsed?.status ?? (/\bdraft\b/i.test(row.join(' ')) ? 'Draft' : ''),
          street: parsed?.street ?? '',
          createdOn: parsed?.createdOn ?? '',
        });
      });
      if (!(await this.gotoNextGridPage())) break;
      await page.waitForTimeout(1_500);
    }
    return [...byId.values()];
  }

  /** Find one record in My Requests by its PVD number (first N pages). Null if absent. */
  async findMyRequestByCaseId(caseId: string, maxPages = 3): Promise<MyRequestRow | null> {
    const rows = await this.readMyRequests({ maxPages });
    return rows.find((r) => r.caseId === caseId) ?? null;
  }

  /** Find one record in My Requests by its entity GUID (first N pages). Null if absent. (The current grid does not expose GUIDs; kept for when it does.) */
  async findMyRequestByEntityId(entityId: string, maxPages = 3): Promise<MyRequestRow | null> {
    const want = entityId.toLowerCase();
    const rows = await this.readMyRequests({ maxPages });
    return rows.find((r) => r.entityId === want) ?? null;
  }

  /** Read the grid's header labels and every data row's cell text in-page. */
  private async dumpGrid(): Promise<{ headers: string[]; rows: string[][]; ids: (string | null)[] }> {
    return this.getPage().evaluate(() => {
      const norm = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
      const grid = document.querySelector('[role="grid"]') || document.querySelector('table');
      if (!grid) return { headers: [] as string[], rows: [] as string[][], ids: [] as (string | null)[] };
      const headers = Array.from(grid.querySelectorAll('[role="columnheader"], thead th')).map((h: any) =>
        norm(h.textContent),
      );
      const rows: string[][] = [];
      const ids: (string | null)[] = [];
      for (const r of Array.from(grid.querySelectorAll('[role="row"], tbody tr')) as any[]) {
        const cellEls = r.querySelectorAll('[role="gridcell"], td');
        if (!cellEls.length) continue; // header / empty row
        rows.push(Array.from(cellEls).map((c: any) => norm(c.textContent)));
        // Power Pages entity lists stamp the record GUID on the row — the only positional-independent key we have.
        const id = (r.getAttribute('data-id') || r.dataset?.id || r.querySelector('[data-id]')?.getAttribute('data-id') || '').toLowerCase();
        ids.push(id || null);
      }
      return { headers, rows, ids };
    });
  }

  /** Advance to the next page of the entity list via its own pager link. Never touches #NextButton. */
  private async gotoNextGridPage(): Promise<boolean> {
    const page = this.getPage();
    // Power Pages entity-list pagers render a rel="next" / aria-label="Next" anchor inside .pagination.
    const next = page
      .locator(
        '.entitylist .pagination a[rel="next"], [role="grid"] a[aria-label="Next"], .pagination li:not(.disabled) a[aria-label*="Next" i]',
      )
      .first();
    if (!(await next.isVisible().catch(() => false))) return false;
    if (await next.evaluate((el: any) => el.closest('li')?.classList.contains('disabled') ?? false).catch(() => false))
      return false;
    await next.click().catch(() => {});
    await page.waitForSelector('[role="grid"] [role="row"], table tbody tr', { timeout: 15_000 }).catch(() => {});
    return true;
  }

  // ── Canary ─────────────────────────────────────────────────

  async canary(): Promise<{ ok: boolean; missing: string[]; notes: string[] }> {
    const page = this.getPage();
    const missing: string[] = [];
    const notes: string[] = [];
    await this.ensureLoggedIn();

    await page.goto(`${this.portal}/my-requests/New-Request/`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(4_000);
    for (const [nm, sel] of Object.entries(STEP1_SELECTORS)) {
      // Honeypot is intentionally not visible — presence is the check.
      const ok =
        nm === 'honeypot'
          ? (await page.locator(sel).count().catch(() => 0)) > 0
          : await page.locator(sel).first().isVisible().catch(() => false);
      if (!ok) missing.push(`step1.${nm} (${sel})`);
    }
    // Lookup modal opens and lists case types (no selection, no Next).
    try {
      await page.locator(STEP1_SELECTORS['caseTypeLaunch']).first().click();
      await page.waitForSelector('.modal.in table tbody tr[data-id]', { timeout: 20_000 });
      const n = await page.locator('.modal.in table tbody tr[data-id]').count();
      notes.push(`lookup modal: ${n} rows on page 1`);
      await page.locator('.modal.in .cancel.btn, .modal.in button[aria-label="Cancel"]').first().click().catch(() => {});
    } catch {
      missing.push('step1.lookupModalRows (.modal.in table tbody tr[data-id])');
    }

    await page.goto(`${this.portal}/my-requests/`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const grid = await page.waitForSelector('[role="grid"] [role="row"]', { timeout: 30_000 }).catch(() => null);
    if (!grid) missing.push('myRequests.grid ([role="grid"] [role="row"])');

    return { ok: missing.length === 0, missing, notes };
  }
}

// ── Pure grid parsers (ported from automation/src/watcher.ts) ──────────────────────────────────

const CASE_ID_RE = /PVD\d{4}-\d+/;

export interface MyRequestRow { caseId: string | null; entityId: string | null; status: string; street: string; createdOn: string }

/** Known Status Reason values the My Requests grid renders, used as a fallback column heuristic. */
const KNOWN_STATUSES = [
  'Draft', 'Submitted', 'Assigned', 'In Progress', 'Active', 'Resolved', 'Cancelled', 'Closed', 'New', 'Completed',
];

interface ParsedRow {
  caseId: string;
  caseType: string;
  street: string;
  status: string;
  createdOn: string;
}

function headerIndex(headers: string[], ...needles: string[]): number {
  return headers.findIndex((h) => needles.some((n) => h.toLowerCase().includes(n)));
}

/** Turn one grid row (its cell texts) into a ParsedRow, using header names when present, heuristics otherwise. */
export function parseRow(headers: string[], cells: string[]): ParsedRow | null {
  const rowText = cells.join(' ');
  const idMatch = rowText.match(CASE_ID_RE);
  if (!idMatch) return null;
  const caseId = idMatch[0];

  const iTitle = headerIndex(headers, 'title', 'name', 'request', 'case');
  const iStreet = headerIndex(headers, 'street', 'address', 'location');
  const iStatus = headerIndex(headers, 'status');
  const iCreated = headerIndex(headers, 'created', 'submitted on', 'date');

  // Title cell: "PVD2026-12345 <Case Type>" → strip the id to get the case type.
  const titleCell = iTitle >= 0 && cells[iTitle] ? cells[iTitle] : cells.find((c) => CASE_ID_RE.test(c)) ?? '';
  const caseType = titleCell.replace(CASE_ID_RE, '').replace(/^[\s|·—-]+/, '').trim();

  // Status: prefer the mapped column; else the first cell that is a known status word.
  let status = iStatus >= 0 && cells[iStatus] ? cells[iStatus].trim() : '';
  if (!status || !isStatusLike(status)) {
    const found = cells.find((c) => isStatusLike(c.trim()));
    if (found) status = found.trim();
  }

  const street =
    iStreet >= 0 && cells[iStreet]
      ? cells[iStreet].trim()
      : (
          cells.find(
            (c, i) =>
              i !== iTitle &&
              c &&
              !CASE_ID_RE.test(c) &&
              !isStatusLike(c) &&
              !looksLikeDate(c) &&
              !/action menu/i.test(c),
          ) ?? ''
        ).trim();

  const createdOn =
    iCreated >= 0 && cells[iCreated] ? cells[iCreated].trim() : (cells.find((c) => looksLikeDate(c)) ?? '').trim();

  return { caseId, caseType, street, status, createdOn };
}

function isStatusLike(s: string): boolean {
  return KNOWN_STATUSES.some((k) => k.toLowerCase() === s.toLowerCase());
}

function looksLikeDate(s: string): boolean {
  return /\d{1,4}[/-]\d{1,2}[/-]\d{1,4}/.test(s) || /\b\d{1,2}:\d{2}\b/.test(s);
}

// ── Node Buffer bridge ─────────────────────────────────────────────────────────────────────────
// setInputFiles({buffer}) needs a real Node Buffer at runtime (Playwright calls buffer.toString('base64'),
// which a plain Uint8Array does not implement). nodejs_compat provides a global Buffer at runtime, but its
// type is not in @cloudflare/workers-types — so reach it through globalThis, untyped.
function nodeBufferFrom(data: string | Uint8Array, encoding?: string): unknown {
  const B = (globalThis as { Buffer?: { from(d: string | Uint8Array, enc?: string): unknown } }).Buffer;
  if (!B) throw new Error('Buffer global unavailable (nodejs_compat required for photo upload)');
  return B.from(data, encoding);
}
