/**
 * deployhold.ts — a deploy evicts an in-flight cron mid-wizard (2026-10-16: the street light died at Step 2, then was
 * filed twice), so the deploy guard (scripts/deploy-guard.mjs) sets meta/engine.deployHoldUntil and runTick starts no
 * new submission until it passes. Pure (no Cloudflare imports) so the unit suite can cover it.
 */
export function deployHoldActive(state: { deployHoldUntil?: number | null } | null | undefined, now: number): boolean {
  return !!state?.deployHoldUntil && state.deployHoldUntil > now;
}
