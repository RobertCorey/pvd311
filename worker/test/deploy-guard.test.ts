import { describe, it, expect } from 'vitest';
import { engineBusy, isGuardedCommand } from '../scripts/deploy-guard.mjs';
import { deployHoldActive } from '../src/deployhold.js';

// 2026-10-16: a deploy at 12:17:58Z evicted the in-flight street-light submit mid-wizard → reaped → filed twice.
describe('deploy guard', () => {
  it('guards deploy and versions upload, not dev', () => {
    expect(isGuardedCommand('deploy')).toBe(true);
    expect(isGuardedCommand('versions upload')).toBe(true);
    expect(isGuardedCommand('dev')).toBe(false);
    expect(isGuardedCommand(undefined)).toBe(false);
  });

  it('busy while the lock is held or a report is processing; unreadable state counts as busy', () => {
    expect(engineBusy({ locked: false, processing: 0 }).busy).toBe(false);
    expect(engineBusy({ locked: true, processing: 0 }).busy).toBe(true);
    expect(engineBusy({ locked: false, processing: 1 }).busy).toBe(true);
    expect(engineBusy({ locked: false, processing: -1 }).busy).toBe(true); // count query failed
    expect(engineBusy({ ok: true, paused: false, pending: 0, awaiting: 0 }).busy).toBe(true); // pre-guard /healthz shape
    expect(engineBusy(null).busy).toBe(true);
  });

  it('a deploy hold stops new submissions until it expires', () => {
    const now = 1_000_000;
    expect(deployHoldActive({ deployHoldUntil: now + 1 }, now)).toBe(true);
    expect(deployHoldActive({ deployHoldUntil: now }, now)).toBe(false);
    expect(deployHoldActive({ deployHoldUntil: null }, now)).toBe(false);
    expect(deployHoldActive(null, now)).toBe(false);
  });
});
