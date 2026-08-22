/**
 * Status watcher — closes the loop for submitted reports without any email dependency.
 *
 * The authenticated wizard has no per-case email field (updates route to the account contact
 * address), so we cannot rely on inbound mail to learn when a case moves Draft → Submitted →
 * Assigned → Resolved/Cancelled. Instead we scrape the account's own My Requests grid
 * (https://311.providenceri.gov/my-requests/), build caseId → {status, street, createdOn}, and
 * diff each Firestore report's live portal status against the last one we recorded (`portalStatus`).
 *
 * Read-only on the portal: we only read the My Requests grid (and, optionally, open the read-only
 * "Record details" flyout to capture the case activity feed). We NEVER click the wizard Next/Submit
 * and NEVER open the New-Request wizard.
 *
 * Wiring: `runWatcher()` is meant to be called on a timer (~every 30 min) from the engine. It
 * assumes Firestore is already initialised (index.ts calls initFirestore() at boot). The CLI entry
 * test-watcher.ts initialises Firestore itself and runs one pass.
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FieldValue } from 'firebase-admin/firestore';
import { config } from './config.js';
import { getDb, invalidateCache } from './firestore.js';
const PORTAL = config.portalBaseUrl;
const __dirname = dirname(fileURLToPath(import.meta.url));
// Same resolution as portal.ts so both share automation/.auth-state.json.
const AUTH_STATE_PATH = process.env['AUTH_STATE_PATH'] || join(__dirname, '..', '..', '..', '.auth-state.json');
/** Opt-in: also open the read-only "Record details" flyout to capture the case activity feed. */
const FETCH_ACTIVITY = process.env['WATCHER_ACTIVITY'] === 'true';
/** Cap portal flyout interactions per run (good-tenant limit). */
const ACTIVITY_MAX = parseInt(process.env['WATCHER_ACTIVITY_MAX'] || '5', 10);
/** Known Status Reason values the My Requests grid renders, used as a fallback column heuristic. */
const KNOWN_STATUSES = [
    'Draft', 'Submitted', 'Assigned', 'In Progress', 'Active', 'Resolved', 'Cancelled', 'Closed', 'New', 'Completed',
];
// ── Portal browser (own page, shared storage state; no edits to portal.ts) ──────────────────────
class WatcherBrowser {
    browser = null;
    context = null;
    page = null;
    reAuthed = false;
    async launch() {
        this.browser = await chromium.launch({ headless: config.headless, args: ['--disable-dev-shm-usage'] });
        const contextOpts = {
            viewport: { width: 1280, height: 900 },
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        };
        if (existsSync(AUTH_STATE_PATH)) {
            contextOpts.storageState = AUTH_STATE_PATH;
            console.log('[watcher] Restoring saved auth state');
        }
        this.context = await this.browser.newContext(contextOpts);
        this.page = await this.context.newPage();
    }
    async close() {
        // Only persist storage state if we actually refreshed the session — avoids racing the
        // engine's PortalSubmitter for the same file on every timer tick.
        if (this.context && this.reAuthed) {
            try {
                await this.context.storageState({ path: AUTH_STATE_PATH });
                console.log('[watcher] Refreshed auth state saved');
            }
            catch { /* non-fatal */ }
        }
        await this.browser?.close();
        this.browser = null;
        this.context = null;
        this.page = null;
    }
    getPage() {
        if (!this.page)
            throw new Error('Watcher browser not launched');
        return this.page;
    }
    /** Same login pattern as PortalSubmitter.ensureLoggedIn (kept local so portal.ts stays untouched). */
    async ensureLoggedIn() {
        const page = this.getPage();
        try {
            await page.goto(`${PORTAL}/my-requests/`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
            if (await page.$('.username')) {
                console.log('[watcher] Already logged in (reused session)');
                return;
            }
        }
        catch { /* fall through to login */ }
        console.log('[watcher] Logging in...');
        await page.goto(`${PORTAL}/SignIn?returnUrl=%2F`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await page.fill('#Username', config.portalEmail);
        await page.fill('#PasswordValue', config.portalPassword);
        await page.click('#submit-signin-local');
        await page.waitForURL('**/', { timeout: 20_000 });
        if (!(await page.$('.username')))
            throw new Error('Portal login failed — no username element after sign-in');
        this.reAuthed = true;
        console.log('[watcher] Logged in successfully');
    }
    /**
     * Scrape My Requests into caseId → row. Follows the grid's own pager (NOT the wizard #NextButton)
     * up to a small cap so a paginated account is fully covered while staying read-only.
     */
    async scrapeMyRequests() {
        const page = this.getPage();
        await page.goto(`${PORTAL}/my-requests/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForSelector('[role="grid"] [role="row"], table tbody tr', { timeout: 30_000 }).catch(() => { });
        await page.waitForTimeout(3_000); // lazy grid render
        const byId = new Map();
        const MAX_PAGES = 20;
        for (let p = 0; p < MAX_PAGES; p++) {
            const { headers, rows } = await this.dumpGrid();
            for (const row of rows) {
                const parsed = parseRow(headers, row);
                if (parsed && !byId.has(parsed.caseId))
                    byId.set(parsed.caseId, parsed);
            }
            if (!(await this.gotoNextGridPage()))
                break;
            await page.waitForTimeout(1_500);
        }
        console.log(`[watcher] Scraped ${byId.size} case row(s) from My Requests`);
        return byId;
    }
    /** Read the grid's header labels and every data row's cell text in-page. */
    async dumpGrid() {
        return this.getPage().evaluate(() => {
            const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
            const grid = document.querySelector('[role="grid"]') || document.querySelector('table');
            if (!grid)
                return { headers: [], rows: [] };
            const headers = Array.from(grid.querySelectorAll('[role="columnheader"], thead th'))
                .map((h) => norm(h.textContent));
            const rows = [];
            for (const r of Array.from(grid.querySelectorAll('[role="row"], tbody tr'))) {
                const cellEls = r.querySelectorAll('[role="gridcell"], td');
                if (!cellEls.length)
                    continue; // header / empty row
                rows.push(Array.from(cellEls).map((c) => norm(c.textContent)));
            }
            return { headers, rows };
        });
    }
    /** Advance to the next page of the entity list via its own pager link. Never touches #NextButton. */
    async gotoNextGridPage() {
        const page = this.getPage();
        // Power Pages entity-list pagers render a rel="next" / aria-label="Next" anchor inside .pagination.
        const next = page.locator('.entitylist .pagination a[rel="next"], [role="grid"] a[aria-label="Next"], .pagination li:not(.disabled) a[aria-label*="Next" i]').first();
        if (!(await next.isVisible().catch(() => false)))
            return false;
        if (await next.evaluate((el) => el.closest('li')?.classList.contains('disabled') ?? false).catch(() => false))
            return false;
        await next.click().catch(() => { });
        await page.waitForSelector('[role="grid"] [role="row"], table tbody tr', { timeout: 15_000 }).catch(() => { });
        return true;
    }
    /**
     * Open a case's read-only "Record details" flyout and capture the POST .../EntityActivity/GetActivities
     * response it fires, returning the latest activity {subject, createdOn}. Best-effort; never throws.
     */
    async fetchLatestActivity(caseId) {
        const page = this.getPage();
        let captured = null;
        const onResponse = (resp) => {
            if (/\/EntityActivity\/GetActivities/i.test(resp.url())) {
                resp.text().then((t) => { captured = t; }).catch(() => { });
            }
        };
        page.on('response', onResponse);
        try {
            const row = page.locator('[role="row"], tbody tr').filter({ hasText: caseId }).first();
            if (!(await row.isVisible().catch(() => false)))
                return null;
            // The title cell renders the case name as a details-view button/link; open it.
            const opener = row.getByRole('button', { name: new RegExp(caseId.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')) });
            const clickTarget = (await opener.count().catch(() => 0))
                ? opener.first()
                : row.locator('td button, [role="gridcell"] button, td a.details-link, [role="gridcell"] a').first();
            await clickTarget.click({ timeout: 5_000 });
            // Wait for the GetActivities XHR to land.
            for (let i = 0; i < 20 && captured === null; i++)
                await page.waitForTimeout(400);
            await page.keyboard.press('Escape').catch(() => { }); // close the flyout, read-only
            if (captured === null)
                return null;
            const latest = parseActivities(captured);
            return latest ? { ...latest, fetchedAt: new Date().toISOString() } : null;
        }
        catch {
            return null;
        }
        finally {
            page.off('response', onResponse);
        }
    }
}
// ── Pure parsers (unit-testable, no browser) ───────────────────────────────────────────────────
const CASE_ID_RE = /PVD\d{4}-\d+/;
function headerIndex(headers, ...needles) {
    return headers.findIndex((h) => needles.some((n) => h.toLowerCase().includes(n)));
}
/** Turn one grid row (its cell texts) into a PortalRow, using header names when present, heuristics otherwise. */
export function parseRow(headers, cells) {
    const rowText = cells.join(' ');
    const idMatch = rowText.match(CASE_ID_RE);
    if (!idMatch)
        return null;
    const caseId = idMatch[0];
    const iTitle = headerIndex(headers, 'title', 'name', 'request', 'case');
    const iStreet = headerIndex(headers, 'street', 'address', 'location');
    const iStatus = headerIndex(headers, 'status');
    const iCreated = headerIndex(headers, 'created', 'submitted on', 'date');
    // Title cell: "PVD2026-12345 <Case Type>" → strip the id to get the case type.
    const titleCell = iTitle >= 0 && cells[iTitle] ? cells[iTitle] : (cells.find((c) => CASE_ID_RE.test(c)) ?? '');
    const caseType = titleCell.replace(CASE_ID_RE, '').replace(/^[\s|·—-]+/, '').trim();
    // Status: prefer the mapped column; else the first cell that is a known status word.
    let status = iStatus >= 0 && cells[iStatus] ? cells[iStatus].trim() : '';
    if (!status || !isStatusLike(status)) {
        const found = cells.find((c) => isStatusLike(c.trim()));
        if (found)
            status = found.trim();
    }
    const street = iStreet >= 0 && cells[iStreet] ? cells[iStreet].trim()
        : (cells.find((c, i) => i !== iTitle && c && !CASE_ID_RE.test(c) && !isStatusLike(c) && !looksLikeDate(c)
            && !/action menu/i.test(c)) ?? '').trim();
    const createdOn = iCreated >= 0 && cells[iCreated] ? cells[iCreated].trim()
        : (cells.find((c) => looksLikeDate(c)) ?? '').trim();
    return { caseId, caseType, street, status, createdOn };
}
function isStatusLike(s) {
    return KNOWN_STATUSES.some((k) => k.toLowerCase() === s.toLowerCase());
}
function looksLikeDate(s) {
    return /\d{1,4}[/-]\d{1,2}[/-]\d{1,4}/.test(s) || /\b\d{1,2}:\d{2}\b/.test(s);
}
/** Best-effort extraction of the latest activity {subject, createdOn} from a GetActivities response body. */
export function parseActivities(body) {
    let data;
    try {
        data = JSON.parse(body);
    }
    catch {
        return null;
    }
    // Find the activity array wherever it lives (array root, or first array-valued property, incl. d.results).
    const items = findActivityArray(data);
    if (!items.length)
        return null;
    const pick = (o, keys) => {
        for (const k of Object.keys(o)) {
            if (keys.some((want) => k.toLowerCase() === want)) {
                const v = o[k];
                if (typeof v === 'string' && v.trim())
                    return v.trim();
                if (typeof v === 'number')
                    return String(v);
            }
        }
        return null;
    };
    let best = null;
    for (const raw of items) {
        if (!raw || typeof raw !== 'object')
            continue;
        const o = raw;
        const subject = pick(o, ['subject', 'title', 'description', 'name', 'activitysubject']);
        if (!subject)
            continue;
        const createdOn = pick(o, ['createdon', 'createdondisplay', 'postedon', 'postedondisplay', 'modifiedon', 'createddate']);
        const t = createdOn ? Date.parse(createdOn) : NaN;
        const score = Number.isNaN(t) ? -1 : t;
        if (!best || score > best.t)
            best = { subject, createdOn, t: score };
    }
    return best ? { subject: best.subject, createdOn: best.createdOn } : null;
}
function findActivityArray(data) {
    if (Array.isArray(data))
        return data;
    if (data && typeof data === 'object') {
        const o = data;
        // OData shape: { d: { results: [...] } } or { d: [...] }
        if (o['d'] !== undefined)
            return findActivityArray(o['d']);
        for (const v of Object.values(o))
            if (Array.isArray(v))
                return v;
    }
    return [];
}
// ── Orchestrator ────────────────────────────────────────────────────────────────────────────────
/**
 * One watch pass: scrape My Requests, diff every `submitted` report's portal status against the last
 * recorded `portalStatus`, persist changes, and return the transitions found.
 */
export async function runWatcher() {
    const db = getDb();
    if (!db)
        throw new Error('Firestore not initialised — call initFirestore() before runWatcher()');
    // Reports we've submitted and have a portal case id for.
    const snap = await db.collection('reports').where('status', '==', 'submitted').get();
    const tracked = snap.docs
        .map((d) => ({ ...d.data(), id: d.id }))
        .filter((r) => !!r.portalCaseId);
    if (!tracked.length) {
        console.log('[watcher] No submitted reports with a portalCaseId — nothing to watch');
        return [];
    }
    console.log(`[watcher] Watching ${tracked.length} submitted report(s)`);
    const browser = new WatcherBrowser();
    const changes = [];
    try {
        await browser.launch();
        await browser.ensureLoggedIn();
        const grid = await browser.scrapeMyRequests();
        if (!grid.size) {
            console.warn('[watcher] My Requests grid returned 0 rows — skipping this pass (login/selector issue?)');
            return [];
        }
        let activityFetches = 0;
        for (const report of tracked) {
            const caseId = report.portalCaseId;
            const row = grid.get(caseId);
            if (!row) {
                console.log(`[watcher]   ${caseId} (report ${report.id}) not found in grid — skipping`);
                continue;
            }
            const from = report.portalStatus ?? null;
            const to = row.status;
            if (!to || to === from)
                continue;
            const update = {
                portalStatus: to,
                portalStatusUpdatedAt: FieldValue.serverTimestamp(),
            };
            let activity = null;
            if (FETCH_ACTIVITY && activityFetches < ACTIVITY_MAX) {
                activityFetches++;
                activity = await browser.fetchLatestActivity(caseId);
                if (activity)
                    update['portalLastActivity'] = activity;
            }
            await db.collection('reports').doc(report.id).update(update);
            console.log(`[watcher]   ${caseId}: ${from ?? '(none)'} → ${to}${activity ? ` (activity: ${activity.subject})` : ''}`);
            changes.push({ reportId: report.id, caseId, from, to, reporterEmail: report.reporterEmail ?? null, activity });
        }
        if (changes.length)
            invalidateCache();
    }
    finally {
        await browser.close();
    }
    console.log(`[watcher] Done — ${changes.length} status change(s)`);
    return changes;
}
