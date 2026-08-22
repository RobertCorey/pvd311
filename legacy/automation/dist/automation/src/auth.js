/**
 * Standalone script to authenticate with the 311 portal and save auth state.
 * Run before launch day so your session is fresh:
 *
 *   npx tsc && node dist/automation/src/auth.js
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_STATE_PATH = join(__dirname, '..', '..', '..', '.auth-state.json');
const PORTAL = config.portalBaseUrl;
async function main() {
    console.log('Launching browser (headed)...');
    const browser = await chromium.launch({ headless: false });
    const contextOpts = {
        viewport: { width: 1280, height: 900 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    };
    // Try existing auth state first
    if (existsSync(AUTH_STATE_PATH)) {
        contextOpts.storageState = AUTH_STATE_PATH;
        console.log('Found existing auth state, checking if still valid...');
    }
    const context = await browser.newContext(contextOpts);
    const page = await context.newPage();
    // Check if already logged in
    try {
        await page.goto(`${PORTAL}/my-requests/`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        const username = await page.$('.username');
        if (username) {
            const text = await username.textContent();
            console.log(`Already logged in as ${text?.trim() || '(unknown)'}`);
            await context.storageState({ path: AUTH_STATE_PATH });
            console.log(`Auth state saved to ${AUTH_STATE_PATH}`);
            await browser.close();
            return;
        }
    }
    catch {
        // Session expired, proceed to login
    }
    // Login
    console.log('Logging in...');
    await page.goto(`${PORTAL}/SignIn?returnUrl=%2F`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.fill('#Username', config.portalEmail);
    await page.fill('#PasswordValue', config.portalPassword);
    await page.click('#submit-signin-local');
    await page.waitForURL('**/', { timeout: 15_000 });
    // Verify
    const username = await page.$('.username');
    if (username) {
        const text = await username.textContent();
        console.log(`Logged in as ${text?.trim() || '(unknown)'}`);
    }
    else {
        console.error('Login may have failed — no username element found');
    }
    // Save
    await context.storageState({ path: AUTH_STATE_PATH });
    console.log(`Auth state saved to ${AUTH_STATE_PATH}`);
    await browser.close();
    console.log('Done. You\'re ready for launch day.');
}
main().catch((err) => {
    console.error('Auth failed:', err.message);
    process.exit(1);
});
