/**
 * Auto-submission engine (Worker port of automation/src/auto.ts + watcher.ts + canary/digest).
 *
 * Cron-driven, stateless between invocations — engine state lives in Firestore meta/engine:
 *   { paused, consecutiveFailures, submissionTimestamps[], lastSubmissionTime, lock:{until} }
 *
 *   runTick(env, ctx)  — every minute: reaper, rate gates, one submission (with HITL gate)
 *   runWatcher(env)    — every 30 min: diff My Requests vs submitted reports, patch portalStatus
 *   runDaily(env)      — daily: digest counts + selector canary (drift alert)
 */
import type { Page } from '@cloudflare/playwright';
import { TERMINAL_PORTAL_STATUS, type Env, type Portal, type ReportDoc, type Store } from './contracts.js';
import { createStore, createAuthStore } from './firestore.js';
import { createPortal } from './portal.js';
import { createMailer } from './email.js';
import { needsHumanApproval, requestReview } from './hitl.js';
import { notifyReport } from './notify.js';
import { markOk, markError, logEvent } from './health.js';
import { fetchCityFeed } from './cityfeed.js';
import { CATEGORIES, isCategory } from '../../shared/categories.js';

// Providence bounding box (same as Node engine).
const PVD_BOUNDS = { minLat: 41.772, maxLat: 41.871, minLng: -71.473, maxLng: -71.370 };

// Tunables (Node config parity).
const MAX_PER_HOUR = 15;
const MIN_GAP_MS = 45_000;
const STUCK_MINUTES = 20;
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = 10 * 60_000;
const DUP_WINDOW_HOURS = 24;
const DUP_DISTANCE_M = 50;
const BREAKER_THRESHOLD = 3;
const LOCK_MS = 12 * 60_000; // must exceed the longest submission (login + wizard + scout + photo); ticks skip while locked

export interface EngineState {
  paused?: boolean;
  consecutiveFailures?: number;
  submissionTimestamps?: number[];
  lastSubmissionTime?: number | null;
  lock?: { until: number } | null;
}

/** Where signed HITL links point (the deployed Worker). */
export function hitlBaseUrl(env: Env): string {
  return (env as unknown as { HITL_BASE_URL?: string }).HITL_BASE_URL
    || 'https://pvd311-worker.pvd311-worker.workers.dev';
}

function blockedAddresses(env: Env): string[] {
  const raw = (env as unknown as { BLOCKED_ADDRESSES?: string }).BLOCKED_ADDRESSES || 'congdon st,congdon street';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// ── One cron tick ────────────────────────────────────────────────────────────────────

export async function runTick(env: Env, _ctx?: ExecutionContext): Promise<void> {
  const store = createStore(env);
  const mailer = createMailer(env);
  const now = Date.now();

  // Atomic lock (compare-and-set on meta/engine) so two overlapping ticks can never both submit.
  if (!(await store.tryAcquireEngineLock(now + LOCK_MS))) {
    console.log('[tick] locked by a running tick, skipping');
    return;
  }
  const state = (await store.getMeta<EngineState>('engine')) ?? {};

  try {
    // Reaper — reports the engine abandoned mid-submit (crash/timeout). Draft bookkeeping is kept for resume.
    for (const stuck of await store.findStuckProcessing(STUCK_MINUTES).catch(() => [] as ReportDoc[])) {
      await store.updateReportStatus(stuck.id, 'failed', `Reaped: stuck in processing > ${STUCK_MINUTES}m`).catch(() => {});
      await logEvent(store, { level: 'warn', kind: 'tick.reaped', msg: `Stuck in processing > ${STUCK_MINUTES}m → failed`, reportId: stuck.id });
      await mailer.alert(`Reaped ${stuck.id}`, `<p>Report <b>${stuck.id}</b> was stuck in processing &gt; ${STUCK_MINUTES}m and was failed. Retry from the dashboard (draft will resume).</p>`);
    }

    if (state.paused) {
      console.log('[tick] engine paused (circuit breaker) — skipping submissions');
      await markOk(store, 'tick', 'paused');
      return;
    }

    // Rate limits.
    const oneHourAgo = now - 60 * 60_000;
    const stamps = (state.submissionTimestamps ?? []).filter((t) => t > oneHourAgo);
    if (stamps.length >= MAX_PER_HOUR) { console.log('[tick] hourly cap reached'); await markOk(store, 'tick', 'hourly cap'); return; }
    if (state.lastSubmissionTime && now - state.lastSubmissionTime < MIN_GAP_MS) { console.log('[tick] min gap not elapsed'); await markOk(store, 'tick', 'min gap'); return; }

    // Oldest pending whose retryAfter has passed.
    const pending = (await store.fetchPendingReports())
      .filter((r) => !r.retryAfter || new Date(r.retryAfter).getTime() <= now);
    if (pending.length === 0) { await markOk(store, 'tick', 'idle'); return; }
    const report = pending[0];

    // Verification gates.
    const rejection = await verifyGates(store, env, report);
    if (rejection) {
      await store.updateReportStatus(report.id, 'auto-rejected', rejection);
      console.log(`[tick] auto-rejected ${report.id}: ${rejection}`);
      await logEvent(store, { level: 'warn', kind: 'tick.auto_rejected', msg: rejection, reportId: report.id });
      await markOk(store, 'tick', 'auto-rejected one');
      return;
    }

    // HITL gate.
    if (await needsHumanApproval(store, env, report)) {
      await requestReview(store, mailer, env, report, hitlBaseUrl(env));
      await logEvent(store, { level: 'info', kind: 'hitl.requested', msg: `Sent for review (${report.category} @ ${report.address})${report.intakeFlags?.length ? ` flags: ${report.intakeFlags.join(',')}` : ''}`, reportId: report.id });
      await markOk(store, 'tick', 'review requested');
      return;
    }

    await submitOne(store, env, mailer, report, stamps, state);
    await markOk(store, 'tick', 'submitted one');
  } catch (err) {
    console.error('[tick] error:', err);
    await markError(store, 'tick', err);
  } finally {
    await store.releaseEngineLock().catch(() => {});
  }
}

/** Returns a rejection reason, or null if the report passes every gate. */
async function verifyGates(store: Store, env: Env, report: ReportDoc): Promise<string | null> {
  if (!isCategory(report.category)) return `Invalid category: ${report.category}`;
  if (CATEGORIES[report.category].photoRequired !== false && !report.photo) return 'No photo attached';
  if (!report.address || !report.address.trim()) return 'No address';

  const addr = report.address.trim().toLowerCase();
  for (const blocked of blockedAddresses(env)) {
    if (addr.includes(blocked.toLowerCase())) return `Blocked address: "${report.address}" matches "${blocked}"`;
  }

  if (report.lat != null && report.lng != null) {
    if (report.lat < PVD_BOUNDS.minLat || report.lat > PVD_BOUNDS.maxLat ||
        report.lng < PVD_BOUNDS.minLng || report.lng > PVD_BOUNDS.maxLng) {
      return `Outside Providence (${report.lat}, ${report.lng})`;
    }
    const recent = await store.findRecentSubmissions(DUP_WINDOW_HOURS);
    for (const existing of recent) {
      if (existing.lat == null || existing.lng == null) continue;
      if (existing.category !== report.category) continue; // a pothole and a streetlight at one corner are two issues
      const dist = haversineMeters(report.lat, report.lng, existing.lat, existing.lng);
      if (dist < DUP_DISTANCE_M) return `Duplicate: within ${Math.round(dist)}m of submitted report ${existing.id}`;
    }
  }
  return null;
}

async function submitOne(
  store: Store,
  env: Env,
  mailer: ReturnType<typeof createMailer>,
  report: ReportDoc,
  stamps: number[],
  state: EngineState,
): Promise<void> {
  const auth = createAuthStore(store);
  const portal = createPortal(env, { auth });
  try {
    await store.updateReportStatus(report.id, 'processing', 'Auto-submission started');
    await portal.launch();
    const result = await portal.submitReport(report, {
      mode: 'live',
      onDraft: (draft) => store.saveReportDraft(report.id, draft),
      saveProof: async (name, bytes) => {
        try { return await store.putProof(report.id, name, bytes, 'image/jpeg'); }
        catch (e) { await logEvent(store, { level: 'warn', kind: 'proof.failed', msg: `Proof screenshot not saved: ${e instanceof Error ? e.message : String(e)}`, reportId: report.id }); throw e; }
      },
    });

    const detail = result.alreadyFiled
      ? `Already filed by an earlier attempt${result.caseId ? ` as ${result.caseId}` : ''} (found by draft GUID)`
      : result.caseId ? `Auto-submitted as ${result.caseId}` : 'Auto-submitted — case number pending (watcher reconciles by GUID)';
    await store.updateReportStatus(report.id, 'submitted', detail, result.caseId);
    await store.patchReport(report.id, { caseIdPending: !result.caseId, portalEntityId: result.entityId ?? report.portalDraft?.entityId ?? null, portalCaseIdCandidate: result.caseIdCandidate ?? report.portalDraft?.caseId ?? null });
    if (result.alreadyFiled) await logEvent(store, { level: 'warn', kind: 'submit.already_filed', msg: detail, reportId: report.id });
    if (!result.caseId) await logEvent(store, { level: 'warn', kind: 'submit.unconfirmed', msg: 'Portal accepted the submission but no case number was read; watcher will reconcile', reportId: report.id });
    await store.setMeta('engine', {
      submissionTimestamps: [...stamps, Date.now()].slice(-50),
      lastSubmissionTime: Date.now(),
      consecutiveFailures: 0,
      paused: false,
    });
    console.log(`[tick] submitted ${report.id}${result.caseId ? ` as ${result.caseId}` : ''}`);
    await markOk(store, 'submit', result.caseId ? `filed as ${result.caseId}` : 'filed (no case id captured)');
    await logEvent(store, { level: 'info', kind: 'submit.ok', msg: `Filed with the city${result.caseId ? ` as ${result.caseId}` : ''} (${report.category} @ ${report.address})`, reportId: report.id, data: { caseId: result.caseId ?? null } });
    {
      const track = `${env.APP_BASE_URL ?? 'https://pvdsnow.org'}/r/${report.id}`;
      await notifyReport(store, mailer, report, `Your report was filed with Providence 311${result.caseId ? ` (${result.caseId})` : ''}`,
        `<p>Your ${escHtml(report.category.replace(/_/g, ' '))} report at ${escHtml(report.address)} was filed with the city${result.caseId ? ` as case <b>${escHtml(result.caseId)}</b>` : ''}.</p><p><a href="${track}">Track it here</a> — we check the city's status every 30 minutes and will email you when it changes.</p><p style="color:#888">FixMyPVD is an independent project, not affiliated with the City of Providence. Reply to stop updates.</p>`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[tick] failed ${report.id}:`, message);
    await markError(store, 'submit', message);
    await logEvent(store, { level: 'error', kind: 'submit.failed', msg: message, reportId: report.id });
    const humanNeeded = /^NEEDS_(REVIEW|MAPPING)/.test(message) || /validation failed/i.test(message);
    const retries = (report.retries ?? 0) + 1;
    if (!humanNeeded && retries <= MAX_RETRIES) {
      await store.requeueReport(report.id, retries, `Auto retry ${retries}/${MAX_RETRIES} after: ${message}`,
        new Date(Date.now() + RETRY_BACKOFF_MS).toISOString()).catch(() => {});
    } else {
      await store.updateReportStatus(report.id, 'failed', `Auto: ${message}`).catch(() => {});
    }

    const consecutiveFailures = (state.consecutiveFailures ?? 0) + 1;
    const paused = consecutiveFailures >= BREAKER_THRESHOLD;
    await store.setMeta('engine', { consecutiveFailures, paused });

    if (/^NEEDS_(REVIEW|MAPPING)/.test(message)) {
      await mailer.alert(`Needs a human — report ${report.id}`, `<pre>${escHtml(message)}</pre>`);
    }
    if (paused) {
      console.error(`[tick] circuit breaker tripped after ${consecutiveFailures} failures`);
      await logEvent(store, { level: 'error', kind: 'engine.breaker', msg: `Circuit breaker tripped after ${consecutiveFailures} consecutive failures — submissions paused` });
      await mailer.alert('Circuit breaker tripped', `<p>Paused after ${consecutiveFailures} consecutive failures.</p><p>Last: ${escHtml(message)}</p><p>Resume from the dashboard.</p>`);
    }
  } finally {
    await portal.close().catch(() => {});
  }
}

// ── Status watcher (every 30 min) ──────────────────────────────────────────────────────

export async function runWatcher(env: Env): Promise<void> {
  const store = createStore(env);
  const mailer = createMailer(env);
  const tracked = await store.listSubmittedWithCaseId();

  const auth = createAuthStore(store);
  const portal = createPortal(env, { auth });
  let changes = 0; let rowCount = 0;
  try {
    await portal.launch();
    await portal.ensureLoggedIn();

    // Reconcile: submissions we could not read a case number for — resolve by the record GUID.
    const unconfirmed = await store.findSubmittedUnconfirmed(20).catch(() => [] as ReportDoc[]);

    // My Requests status diff (skipped when we have nothing to watch, but the city feed below still runs).
    if (tracked.length || unconfirmed.length) {
      const rows = await portal.readMyRequests();
      rowCount = rows.length;
      if (!rows.length) {
        console.warn('[watcher] My Requests returned 0 rows — skipping diff');
      } else {
        const byId = new Map(rows.filter((r) => r.caseId).map((r) => [r.caseId as string, r]));
        const byEntity = new Map(rows.filter((r) => r.entityId).map((r) => [r.entityId as string, r]));
        for (const u of unconfirmed) {
          const cand = u.portalCaseIdCandidate ?? u.portalDraft?.caseId ?? null;
          const eid = ((u as unknown as { portalEntityId?: string | null }).portalEntityId ?? u.portalDraft?.entityId ?? '').toLowerCase();
          const row = (cand ? byId.get(cand) : undefined) ?? (eid ? byEntity.get(eid) : undefined);
          if (row?.caseId && !/^draft$/i.test(row.status)) {
            await store.updateReportStatus(u.id, 'submitted', `Case number confirmed by watcher: ${row.caseId}`, row.caseId);
            await store.patchReport(u.id, { caseIdPending: false });
            await logEvent(store, { level: 'info', kind: 'watcher.case_confirmed', msg: `Case number ${row.caseId} confirmed by GUID`, reportId: u.id, data: { caseId: row.caseId } });
            tracked.push({ ...u, portalCaseId: row.caseId });
          } else if (row && /^draft$/i.test(row.status)) {
            // The portal still shows it as a Draft: the submit did NOT take. Put it back in the queue to resume the draft.
            await store.requeueReport(u.id, u.retries ?? 0, 'Watcher: portal still shows Draft — re-submitting', new Date().toISOString());
            await store.patchReport(u.id, { caseIdPending: false });
            await logEvent(store, { level: 'warn', kind: 'watcher.draft_not_submitted', msg: 'Portal still shows this as a Draft; re-queued', reportId: u.id });
          }
        }
        for (const report of tracked) {
          const caseId = report.portalCaseId;
          if (!caseId) continue;
          const row = byId.get(caseId);
          if (!row) continue;
          const from = report.portalStatus ?? null;
          const to = row.status;
          if (!to || to === from) continue;

          await store.patchReport(report.id, { portalStatus: to, portalStatusUpdatedAt: new Date() });
          console.log(`[watcher] ${caseId}: ${from ?? '—'} → ${to}`);
          changes++;
          await logEvent(store, { level: 'info', kind: 'watcher.status', msg: `${caseId}: ${from ?? '—'} → ${to}`, reportId: report.id, data: { from, to, caseId } });
          {
            const track = `${env.APP_BASE_URL ?? 'https://pvdsnow.org'}/r/${report.id}`;
            const friendly: Record<string, string> = { Submitted: 'has been received by the city', Assigned: 'was assigned to a city crew', 'In Progress': 'is being worked on by the city', Resolved: 'is marked resolved by the city', Closed: 'was closed by the city', Completed: 'was completed by the city', Cancelled: 'was cancelled by the city', Canceled: 'was cancelled by the city' };
            await notifyReport(store, mailer, report, `Your report ${caseId} ${friendly[to] ?? `is now ${to}`}`,
              `<p>Your ${escHtml(report.category.replace(/_/g, ' '))} report at ${escHtml(report.address)} (city case <b>${escHtml(caseId)}</b>) ${escHtml(friendly[to] ?? `is now ${to}`)}.</p><p><a href="${track}">Track it here</a>.</p><p style="color:#888">FixMyPVD is an independent project, not affiliated with the City of Providence. Reply to stop updates.</p>`);
          }
          if (TERMINAL_PORTAL_STATUS.test(to)) {
            await mailer.alert(`${caseId} is now ${to}`, `<p><b>${escHtml(caseId)}</b> is now <b>${escHtml(to)}</b> (report ${escHtml(report.id)}).</p>`);
          }
        }
      }
    } else {
      console.log('[watcher] nothing to watch');
    }

    // City-wide public feed (anonymous PCF grid) → meta/cityFeed. Non-fatal; reuses this page.
    try {
      await fetchCityFeed(env, portalPage(portal), store);
      const feed = await store.getMeta<{ items?: unknown[] }>('cityFeed').catch(() => null);
      await markOk(store, 'cityfeed', `${feed?.items?.length ?? 0} items`);
    } catch (e) {
      console.error('[watcher] city feed failed:', e instanceof Error ? e.message : e);
      await markError(store, 'cityfeed', e);
    }
    await markOk(store, 'watcher', `${tracked.length} tracked, ${rowCount} rows, ${changes} change${changes === 1 ? '' : 's'}`);
  } catch (e) {
    await markError(store, 'watcher', e);
    throw e;
  } finally {
    await portal.close().catch(() => {});
  }
}

/**
 * The city feed reuses the watcher's already-open (logged-in) page to avoid a second Browser Run
 * session. The Portal interface doesn't expose its page, so reach the WorkerPortal's private field
 * directly — cheaper than launching a browser just for the read-only /public-requests/ scrape.
 */
function portalPage(portal: Portal): Page {
  const p = (portal as unknown as { page?: Page | null }).page;
  if (!p) throw new Error('portal page unavailable (launch() not called?)');
  return p;
}

// ── Daily digest + selector canary ─────────────────────────────────────────────────────

export async function runDaily(env: Env): Promise<void> {
  const store = createStore(env);
  const mailer = createMailer(env);

  // Retention: photos are deleted 30 days after the city resolves/cancels the case (privacy promise).
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 3_600_000);
    for (const r of await store.findResolvedBefore(cutoff, 50)) {
      const id = r.photo?.match(/\/api\/photos\/([A-Za-z0-9_-]+)/)?.[1] ?? r.id;
      await store.deletePhoto(id).catch(() => {});
      await store.patchReport(r.id, { photo: null, photoDeletedAt: new Date().toISOString() });
      console.log(`[retention] deleted photo for ${r.id}`);
      await logEvent(store, { level: 'info', kind: 'retention.photo_deleted', msg: 'Photo deleted 30 days after the city closed the case', reportId: r.id });
    }
    const purged = await store.deleteEventsBefore(new Date(Date.now() - 14 * 24 * 3_600_000), 500).catch(() => 0);
    if (purged) console.log(`[retention] purged ${purged} old events`);
  } catch (e) { console.error('[retention] failed:', e); await markError(store, 'daily', e); }

  try {
    const [submitted, pending, awaiting, failed, processing] = await Promise.all([
      store.countByStatus('submitted'),
      store.countByStatus('pending'),
      store.countByStatus('awaiting_review'),
      store.countByStatus('failed'),
      store.countByStatus('processing'),
    ]);
    await mailer.alert(
      'Daily digest',
      `<p><b>Queue snapshot</b></p><ul>`
      + `<li>submitted ${submitted}</li><li>pending ${pending}</li>`
      + `<li>awaiting review ${awaiting}</li><li>failed ${failed}</li><li>processing ${processing}</li></ul>`,
    );
  } catch (e) { console.error('[digest] failed:', e); } // never skip the canary because the digest failed

  // Selector canary (zero-draft): alert only on drift.
  const auth = createAuthStore(store);
  const portal = createPortal(env, { auth });
  try {
    await portal.launch();
    const canary = await portal.canary();
    if (!canary.ok) {
      await mailer.alert('Portal drift', `<p>Selector canary failed.</p><p>Missing: ${escHtml(canary.missing.join(', '))}</p><p>Notes: ${escHtml(canary.notes.join('; '))}</p>`);
      await markError(store, 'canary', `Missing: ${canary.missing.join(', ')}`);
      await logEvent(store, { level: 'error', kind: 'canary.drift', msg: `Portal form changed — missing: ${canary.missing.join(', ')}`, data: { notes: canary.notes } });
    } else {
      console.log(`[daily] canary OK (${canary.notes.join('; ')})`);
      await markOk(store, 'canary', canary.notes.join('; '));
    }
    await markOk(store, 'daily');
  } catch (e) {
    await mailer.alert('Canary could not run', `<pre>${escHtml(e instanceof Error ? e.message : String(e))}</pre>`);
    await markError(store, 'canary', e);
  } finally {
    await portal.close().catch(() => {});
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────────────

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
