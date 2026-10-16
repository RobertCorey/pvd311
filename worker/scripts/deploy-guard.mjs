#!/usr/bin/env node
/**
 * Deploy guard — wrangler.toml [build] command, so it runs inside every `wrangler deploy` / `wrangler versions upload`
 * (local or CI) and does nothing for `wrangler dev`.
 *
 * Why: a deploy evicts an in-flight cron invocation without unwinding it. On 2026-10-16 a deploy at 12:17:58Z killed
 * the street-light submit mid-wizard (no catch, no finally — the engine lock only cleared when its lease ran out); the
 * reaper failed it, the retry filed it, and the watcher filed it again (PVD2026-90094 + -90098).
 *
 * What: with CANARY_TOKEN (env, else ~/.config/pvd311/ops.env) it first sets a deploy hold (POST /api/deploy-hold) so
 * no NEW submission starts, then waits until no submission is in flight (engine lock free AND no report in
 * 'processing'), then shortens the hold to cover the upload. Without a token (CI) it can only wait for idle via the
 * public /healthz. Refuses the deploy (exit 1) if the engine stays busy or its state can't be read.
 *
 * Env: DEPLOY_GUARD=off (skip, loudly) · DEPLOY_GUARD_URL (default https://api.fixmypvd.org) ·
 *      DEPLOY_GUARD_WAIT_S (default 360 — the longest live submit so far was ~4.5 min) · CANARY_TOKEN
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Busy = a submission may be mid-wizard. Unknown (fields missing) counts as busy. Pure. */
export function engineBusy(s) {
  if (!s || typeof s.locked !== 'boolean' || typeof s.processing !== 'number' || s.processing < 0) return { busy: true, why: 'engine state unreadable' };
  if (s.locked) return { busy: true, why: 'engine lock held (a tick is running)' };
  if (s.processing > 0) return { busy: true, why: `${s.processing} report(s) in processing` };
  return { busy: false, why: 'idle' };
}

/** Only deploys are guarded; `wrangler dev` (and anything else that runs the build) passes straight through. Pure. */
export function isGuardedCommand(cmd) {
  return /^(deploy|versions)\b/.test(cmd ?? '');
}

function canaryToken() {
  if (process.env.CANARY_TOKEN) return process.env.CANARY_TOKEN;
  try {
    const line = readFileSync(join(homedir(), '.config/pvd311/ops.env'), 'utf8').split('\n').find((l) => l.startsWith('CANARY_TOKEN='));
    return line ? line.slice('CANARY_TOKEN='.length).trim() : '';
  } catch { return ''; }
}

async function main() {
  const cmd = process.env.WRANGLER_COMMAND;
  if (!isGuardedCommand(cmd)) return 0;
  const log = (m) => console.log(`[deploy-guard] ${m}`);
  if (process.env.DEPLOY_GUARD === 'off') {
    console.warn('[deploy-guard] DEPLOY_GUARD=off — NOT checking for an in-flight submission. A deploy mid-submit can file a report twice.');
    return 0;
  }
  const base = (process.env.DEPLOY_GUARD_URL || 'https://api.fixmypvd.org').replace(/\/$/, '');
  const waitS = Number(process.env.DEPLOY_GUARD_WAIT_S || 360);
  const token = canaryToken();
  const hold = async (seconds) => {
    const r = await fetch(`${base}/api/deploy-hold?seconds=${seconds}`, { method: 'POST', headers: { 'x-canary-token': token } });
    if (!r.ok) throw new Error(`deploy-hold ${r.status}`);
    return r.json();
  };
  let held = false;
  if (token) {
    try { await hold(waitS + 120); held = true; log(`hold set: no new submission starts for ${waitS + 120}s`); }
    catch (e) { log(`could not set a deploy hold (${e.message}) — waiting for idle without one`); }
  } else {
    log('no CANARY_TOKEN — waiting for idle without a deploy hold (a new submit could still start before the upload)');
  }
  const read = async () => {
    try {
      const r = await fetch(`${base}/healthz`);
      return r.ok ? await r.json() : null;
    } catch { return null; }
  };
  const deadline = Date.now() + waitS * 1000;
  for (;;) {
    const { busy, why } = engineBusy(await read());
    if (!busy) break;
    if (Date.now() > deadline) {
      if (held) await hold(0).catch(() => {});
      console.error(`[deploy-guard] REFUSING to deploy: ${why} after ${waitS}s. Retry when the engine is idle, or DEPLOY_GUARD=off if you are sure.`);
      return 1;
    }
    log(`waiting: ${why}`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
  // Idle. Keep the hold just long enough to cover bundling + upload + rollout; it expires on its own.
  if (held) await hold(120).catch(() => {});
  log(held ? 'engine idle — deploying (submissions held ~2 min)' : 'engine idle — deploying');
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => process.exit(code), (e) => { console.error('[deploy-guard] failed:', e); process.exit(1); });
}
