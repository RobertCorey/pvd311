/**
 * Selector canary — detects portal drift WITHOUT creating a draft.
 * Logs in, loads the New-Request wizard (Step 1 only — no Next click), asserts every selector the
 * submitter depends on, then checks My Requests renders. Alerts on any miss.
 *   node dist/automation/src/canary.js   (or runCanary() from the engine on a daily timer)
 */
import { PortalSubmitter } from './portal.js';
import { config } from './config.js';
import { alert } from './telegram.js';
const STEP1_SELECTORS = {
    requestType: '#casetypecode',
    caseTypeLaunch: 'button[aria-label*="Case Type" i][aria-label*="lookup modal" i]',
    notificationMethod: '#cop_methodofupdate',
    nextButton: '#NextButton',
    honeypot: 'input[id^="frm_pref_"]',
};
export async function runCanary() {
    const portal = new PortalSubmitter();
    const missing = [];
    const notes = [];
    await portal.launch();
    try {
        await portal.ensureLoggedIn();
        const page = portal.pageForReadOnlyChecks();
        await page.goto(`${config.portalBaseUrl}/my-requests/New-Request/`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await page.waitForTimeout(4_000);
        for (const [name, sel] of Object.entries(STEP1_SELECTORS)) {
            // Honeypot is intentionally not visible — presence is the check.
            const ok = name === 'honeypot'
                ? (await page.locator(sel).count().catch(() => 0)) > 0
                : await page.locator(sel).first().isVisible().catch(() => false);
            if (!ok)
                missing.push(`step1.${name} (${sel})`);
        }
        // Lookup modal opens and lists case types (no selection, no Next)
        try {
            await page.locator(STEP1_SELECTORS['caseTypeLaunch']).first().click();
            await page.waitForSelector('.modal.in table tbody tr[data-id]', { timeout: 20_000 });
            const n = await page.locator('.modal.in table tbody tr[data-id]').count();
            notes.push(`lookup modal: ${n} rows on page 1`);
            await page.locator('.modal.in .cancel.btn, .modal.in button[aria-label="Cancel"]').first().click().catch(() => { });
        }
        catch {
            missing.push('step1.lookupModalRows (.modal.in table tbody tr[data-id])');
        }
        await page.goto(`${config.portalBaseUrl}/my-requests/`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        const grid = await page.waitForSelector('[role="grid"] [role="row"]', { timeout: 30_000 }).catch(() => null);
        if (!grid)
            missing.push('myRequests.grid ([role="grid"] [role="row"])');
    }
    finally {
        await portal.close();
    }
    const ok = missing.length === 0;
    const summary = ok ? `✅ Portal canary OK (${notes.join('; ')})` : `🚨 <b>Portal drift</b> — missing: ${missing.join(', ')}`;
    console.log(`[canary] ${summary.replace(/<[^>]+>/g, '')}`);
    if (!ok)
        await alert(summary);
    return { ok, missing, notes };
}
if (process.argv[1] && /canary\.js$/.test(process.argv[1])) {
    runCanary().then((r) => process.exit(r.ok ? 0 : 2)).catch((e) => { console.error(e); process.exit(1); });
}
