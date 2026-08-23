/**
 * browser.ts — resolve a REAL Playwright Chromium for the simulator tests.
 *
 * WHY THIS EXISTS (the seam):
 *   The driver (worker/src/portal.ts) imports `launch` from `@cloudflare/playwright`.
 *   That package's `launch()` connects over a Cloudflare Browser Rendering (`env.BROWSER`)
 *   binding, and its bundled playwright-core deliberately stubs `child_process.spawn`
 *   ("spawn not implemented") — it CANNOT start a local browser. It also imports the
 *   Workers-only virtual module `cloudflare:workers`, which does not resolve under Node/vitest.
 *
 *   So the sim tests `vi.mock('@cloudflare/playwright')` and route the driver's `launch()`
 *   to a real, locally-spawned Chromium via a normal Playwright build. The driver's page
 *   logic is byte-for-byte the production code; only the browser transport differs.
 *   `PORTAL_BASE_URL` points at the local sim server, so the real Chromium talks plain HTTP
 *   to localhost and never reaches 311.providenceri.gov.
 *
 * We do NOT add a new dependency to worker/package.json. Instead we resolve a Playwright that
 * already exists in the repo (installed for other packages). Candidates, in order:
 *   worker/ (if ever added) → app/ → legacy/automation/.
 * If none is found the tests throw a clear, actionable error rather than silently passing.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url)); // worker/test/sim
const REPO_ROOT = resolve(HERE, '..', '..', '..'); // → repo root

const CANDIDATES = [
  'worker/node_modules/playwright/index.js',
  'worker/node_modules/playwright-core/index.js',
  'app/node_modules/playwright/index.js',
  'app/node_modules/playwright-core/index.js',
  'legacy/automation/node_modules/playwright/index.js',
  'legacy/automation/node_modules/playwright-core/index.js',
].map((p) => resolve(REPO_ROOT, p));

export interface RealChromium {
  launch(opts?: Record<string, unknown>): Promise<any>;
}

let cached: { chromium: RealChromium; source: string } | null = null;

/** Load a real Playwright `chromium` from the repo. Cached across calls. */
export async function loadRealChromium(): Promise<{ chromium: RealChromium; source: string }> {
  if (cached) return cached;
  const found = CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      'portal.sim tests need a real Playwright build. None found in worker/, app/, or ' +
        'legacy/automation/ node_modules. Run `npm install` (and `npx playwright install chromium`) ' +
        'in one of those packages, then re-run `cd worker && npx vitest run`.',
    );
  }
  const mod: any = await import(pathToFileURL(found).href);
  const chromium: RealChromium | undefined = mod.chromium ?? mod.default?.chromium;
  if (!chromium?.launch) throw new Error(`Resolved Playwright at ${found} but it has no chromium.launch`);
  cached = { chromium, source: found };
  return cached;
}

/** Launch a headless Chromium suitable for CI (no-sandbox). */
export async function launchLocalChromium(): Promise<any> {
  const { chromium } = await loadRealChromium();
  return chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
}
