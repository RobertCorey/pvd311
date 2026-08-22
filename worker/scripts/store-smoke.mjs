/**
 * store-smoke.mjs — exercises worker/src/firestore.ts against PROD Firestore (pvd-snow-report),
 * read-only except one harmless setMeta('smoke', ...).
 *
 * Run from anywhere:
 *   node --experimental-strip-types worker/scripts/store-smoke.mjs
 *
 * It loads the service account from automation/service-account.json (path taken from
 * FIREBASE_SERVICE_ACCOUNT_PATH in automation/.env), builds a fake Env, and imports the compiled
 * firestore module. The service-account JSON is never printed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url)); // worker/scripts
const repoRoot = resolve(here, '..', '..');
const automationDir = resolve(repoRoot, 'automation');

// Read ONLY FIREBASE_SERVICE_ACCOUNT_PATH from automation/.env; never print any secret.
const envText = readFileSync(resolve(automationDir, '.env'), 'utf-8');
const m = envText.match(/^FIREBASE_SERVICE_ACCOUNT_PATH=(.*)$/m);
if (!m) throw new Error('FIREBASE_SERVICE_ACCOUNT_PATH not found in automation/.env');
const saPath = resolve(automationDir, m[1].trim());

const saJson = readFileSync(saPath, 'utf-8');
const sa = JSON.parse(saJson);

/** @type {import('../src/contracts.ts').Env} */
const env = {
  FIREBASE_SERVICE_ACCOUNT: saJson,
  FIREBASE_PROJECT_ID: sa.project_id,
  STORAGE_BUCKET: `${sa.project_id}.firebasestorage.app`,
};

const { createStore, createAuthStore } = await import('../src/firestore.ts');
const store = createStore(env);

const out = {};
try {
  out.project = sa.project_id;
  out.pendingCount = (await store.fetchPendingReports()).length;
  out.rejectedCount = await store.countByStatus('rejected');
  out.recentSubmissions24h = (await store.findRecentSubmissions(24)).length;
  const engine = await store.getMeta('engine');
  out.engineMeta = engine
    ? { keys: Object.keys(engine), paused: engine.paused, consecutiveFailures: engine.consecutiveFailures }
    : null;

  // Single harmless write, then read it back to prove the round-trip.
  const at = new Date().toISOString();
  await store.setMeta('smoke', { at });
  const smoke = await store.getMeta('smoke');
  out.smokeWriteRoundTrip = smoke?.at === at;

  // AuthStore load (read-only): does meta/portalAuth exist?
  const authStore = createAuthStore(store);
  const authState = await authStore.load();
  out.authStatePresent = authState !== null;
} catch (e) {
  out.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

console.log(JSON.stringify(out, null, 2));
if (out.error) process.exit(1);
