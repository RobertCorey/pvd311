/**
 * PVD311 Worker — entry point.
 *
 * Cron triggers (wrangler.toml [triggers]):
 *   every minute  → runTick    (submit one pending report, with reaper + HITL gate)
 *   every 30 min  → runWatcher  (diff My Requests vs submitted reports)
 *   daily 11:00Z  → runDaily    (digest + selector canary; 11:00 UTC = 06:00 EST / 07:00 EDT — crons are UTC-only)
 *
 * HTTP:
 *   GET /healthz                         → { ok, paused, pending, awaiting }
 *   GET /canary            (x-canary-token) → portal.canary()  (read-only, zero-draft)
 *   GET /api/status        (x-canary-token) → engine state + status counts
 *   GET /hitl/approve?id&sig             → verify HMAC, approve, tiny HTML page
 *   GET /hitl/reject?id&sig              → verify HMAC, reject, tiny HTML page
 */
import type { Env } from './contracts.js';
import { runTick, runWatcher, runDaily, type EngineState } from './engine.js';
import { createStore, createAuthStore } from './firestore.js';
import { createPortal } from './portal.js';
import { signAction, timingSafeEqualHex } from './email.js';
import { approve, reject } from './hitl.js';

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    switch (controller.cron) {
      case '* * * * *':
        await runTick(env, ctx);
        break;
      case '*/30 * * * *':
        ctx.waitUntil(runWatcher(env));
        break;
      case '0 11 * * *':
        ctx.waitUntil(runDaily(env));
        break;
      default:
        // Unknown schedule — run the submit tick as the safe default.
        await runTick(env, ctx);
    }
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/healthz') {
      const store = createStore(env);
      const [state, pending, awaiting] = await Promise.all([
        store.getMeta<EngineState>('engine').catch(() => null),
        store.countByStatus('pending').catch(() => -1),
        store.countByStatus('awaiting_review').catch(() => -1),
      ]);
      return Response.json({ ok: true, paused: !!state?.paused, pending, awaiting });
    }

    if (url.pathname === '/canary') {
      if (request.headers.get('x-canary-token') !== env.CANARY_TOKEN) return new Response('unauthorized', { status: 401 });
      const store = createStore(env);
      const auth = createAuthStore(store);
      const portal = createPortal(env, { auth });
      try {
        await portal.launch();
        const report = await portal.canary();
        return Response.json(report, { status: report.ok ? 200 : 500 });
      } catch (e) {
        return Response.json({ ok: false, missing: [], notes: [], error: e instanceof Error ? e.message : String(e) }, { status: 500 });
      } finally {
        await portal.close().catch(() => {});
      }
    }

    if (url.pathname === '/api/status') {
      if (request.headers.get('x-canary-token') !== env.CANARY_TOKEN) return new Response('unauthorized', { status: 401 });
      const store = createStore(env);
      const [state, submitted, pending, awaiting, failed, processing, rejected] = await Promise.all([
        store.getMeta<EngineState>('engine').catch(() => null),
        store.countByStatus('submitted').catch(() => -1),
        store.countByStatus('pending').catch(() => -1),
        store.countByStatus('awaiting_review').catch(() => -1),
        store.countByStatus('failed').catch(() => -1),
        store.countByStatus('processing').catch(() => -1),
        store.countByStatus('rejected').catch(() => -1),
      ]);
      const oneHourAgo = Date.now() - 60 * 60_000;
      return Response.json({
        engine: {
          paused: !!state?.paused,
          consecutiveFailures: state?.consecutiveFailures ?? 0,
          submissionsThisHour: (state?.submissionTimestamps ?? []).filter((t) => t > oneHourAgo).length,
          lastSubmissionTime: state?.lastSubmissionTime ? new Date(state.lastSubmissionTime).toISOString() : null,
          locked: !!(state?.lock && state.lock.until > Date.now()),
        },
        counts: { submitted, pending, awaiting_review: awaiting, failed, processing, rejected },
      });
    }

    if (url.pathname === '/hitl/approve' || url.pathname === '/hitl/reject') {
      const action = url.pathname.endsWith('approve') ? 'approve' : 'reject';
      const id = url.searchParams.get('id');
      const sig = url.searchParams.get('sig');
      if (!id || !sig) return htmlPage('Bad request', 'Missing id or signature.', 400);
      const expected = await signAction(env.HITL_SECRET, action, id);
      if (!timingSafeEqualHex(sig, expected)) return htmlPage('Invalid link', 'This approval link is invalid or has expired.', 401);
      const store = createStore(env);
      try {
        if (action === 'approve') {
          await approve(store, id, 'email');
          return htmlPage('Approved', 'Approved — will submit on the next tick.');
        }
        await reject(store, id, 'email');
        return htmlPage('Rejected', 'Rejected — this report will not be submitted.');
      } catch (e) {
        return htmlPage('Error', `Could not record the decision: ${e instanceof Error ? e.message : String(e)}`, 500);
      }
    }

    return new Response('pvd311-worker', { status: 200 });
  },
} satisfies ExportedHandler<Env>;

function htmlPage(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${esc(title)}</title>`
    + `<div style="font-family:system-ui,sans-serif;max-width:32rem;margin:16vh auto;padding:0 1.25rem;text-align:center">`
    + `<h1 style="font-size:1.4rem">${esc(title)}</h1><p style="color:#444;font-size:1.05rem">${esc(body)}</p></div>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
