/**
 * city-questions-fixtures.sim.test.ts — CI guard (job "portal-sim"): each sim Step-3 fixture vs the committed city
 * seed (shared/city-questions.seed.json) for its category.
 *
 * Every fixture is rendered by the sim (test/sim/server.ts) through the real wizard, dumped with the production
 * collector (`collectStep3Controls`), and compared with the seed using the SAME flag logic a live filing gets
 * (cityquestions.auditFiling): new_question / gone / options_changed / app_option_stale. Labels are not compared.
 *
 * Known drifts are listed in KNOWN_DRIFT, each with a TODO; anything else fails, and so does an allowlist entry
 * that no longer happens (so the list cannot rot). Fix a drift by updating the fixture from a live dump
 * (docs/city-questions.md phase 3), then delete its entry.
 */
import { describe, it, beforeAll, afterAll, expect, vi } from 'vitest';
// portal.ts imports @cloudflare/playwright (cloudflare:workers, unresolvable under Node). We only need its pure collector.
vi.mock('@cloudflare/playwright', () => ({ launch: async () => { throw new Error('uses launchLocalChromium'); } }));
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { startSim, type Sim } from './sim/server';
import { launchLocalChromium } from './sim/browser';
import { collectStep3Controls } from '../src/portal';
import { auditFiling, SEED } from '../src/cityquestions';
import { CATEGORIES } from '../../shared/categories.js';
import type { PortalControl } from '../src/scout';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), 'sim', 'fixtures', 'step3');

/** `<category>`: ["<flag kind>:<control id>", …] — drift we know about. Each needs a TODO. */
const KNOWN_DRIFT: Record<string, string[]> = {
  // TODO(city-questions phase 3): live radio options read "Request Type <option>" (the collector keeps the
  // aria-label prefix); the fixture's aria-labels are the bare option text.
  bins_carts: ['options_changed:cop_cartrequesttype'],
};

describe('sim Step-3 fixtures vs the city-questions seed', () => {
  let sim: Sim;
  let browser: any;
  const categories = readdirSync(FIXTURES).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5)).sort();

  beforeAll(async () => {
    sim = await startSim();
    browser = await launchLocalChromium();
  }, 60_000);
  afterAll(async () => {
    await browser?.close().catch(() => {});
    await sim?.close();
  });

  it('every fixture is a real category and every KNOWN_DRIFT entry has a fixture', () => {
    for (const c of categories) expect(CATEGORIES[c], c).toBeTruthy();
    for (const c of Object.keys(KNOWN_DRIFT)) expect(categories).toContain(c);
  });

  it('fixture controls match the seed, except the listed known drifts', async () => {
    const context = await browser.newContext();
    await context.addCookies([{ name: 'sim_auth', value: '1', url: sim.url }]);
    const page = await context.newPage();
    const got: Record<string, string[]> = {};
    for (const category of categories) {
      const cfg = CATEGORIES[category];
      await page.goto(`${sim.url}/my-requests/New-Request/`, { waitUntil: 'domcontentloaded' });
      await page.evaluate((guid: string) => {
        (document.querySelector('#cop_casetype_guid') as any).value = guid;
        (document.querySelector('#casetypecode') as any).value = '2';
        (document.querySelector('#step1form') as any).submit();
      }, cfg.portalCaseTypeGuid);
      await page.waitForURL(/stepid=step2/, { timeout: 15_000 });
      const entityId = await page.$eval('#EntityFormView_EntityID', (el: any) => el.value);
      await page.goto(`${sim.url}/my-requests/New-Request/?stepid=step3&id=${entityId}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#description', { timeout: 15_000 });
      const controls = (await page.evaluate(collectStep3Controls)) as PortalControl[];
      const { flags } = auditFiling({ category, reportId: 'fixture', at: '2026-10-16T00:00:00.000Z', prev: null, controls, seed: SEED.categories[category] ?? [] });
      got[category] = flags.map((f) => `${f.kind}:${f.questionId}`).sort();
    }
    await context.close();

    const want = Object.fromEntries(categories.map((c) => [c, [...(KNOWN_DRIFT[c] ?? [])].sort()]));
    expect(got).toEqual(want); // a NEW drift (or a fixed one still listed) fails here
  }, 120_000);
});
