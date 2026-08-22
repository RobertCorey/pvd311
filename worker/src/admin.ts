/**
 * Minimal ops page: GET /admin?token=<CANARY_TOKEN>  (pre-launch stopgap; move behind Cloudflare Access later)
 * Lists awaiting_review / failed / pending / recent submitted; buttons POST /admin/action.
 */
import { CATEGORIES } from '../../shared/categories.js';
import type { Env, Store, ReportDoc } from './contracts.js';
import { approve, reject } from './hitl.js';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const when = (t: unknown) => { const ts = t as { toDate?: () => Date; seconds?: number } | string | null; if (!ts) return ''; if (typeof ts === 'string') return ts.slice(0, 16); if (ts.toDate) return ts.toDate().toISOString().slice(0, 16); if (ts.seconds) return new Date(ts.seconds * 1000).toISOString().slice(0, 16); return ''; };

function row(r: ReportDoc, token: string): string {
  const cat = CATEGORIES[r.category]?.label ?? r.category;
  const btn = (a: string, label: string) => `<form method="post" action="/admin/action" style="display:inline"><input type="hidden" name="token" value="${esc(token)}"><input type="hidden" name="id" value="${esc(r.id)}"><input type="hidden" name="action" value="${a}"><button>${label}</button></form>`;
  const actions = r.status === 'awaiting_review' ? btn('approve', '✅ Approve') + ' ' + btn('reject', '❌ Reject')
    : r.status === 'failed' ? btn('requeue', '↻ Requeue') + ' ' + btn('reject', '❌ Reject')
    : r.status === 'pending' ? btn('reject', '❌ Reject') : '';
  return `<tr><td><code>${esc(r.id)}</code></td><td>${esc(cat)}</td><td>${esc(r.address)}</td><td>${esc((r.description ?? '').slice(0, 120))}</td><td>${r.photo ? `<a href="${esc(r.photo)}" target="_blank">photo</a>` : ''}</td><td>${esc(r.status)}<br><small>${esc(r.statusDetail ?? '')}</small></td><td>${esc(r.portalCaseId ?? '')} ${esc(r.portalStatus ?? '')}</td><td>${when(r.timestamp)}</td><td>${actions}</td></tr>`;
}

export async function adminPage(env: Env, store: Store, token: string): Promise<Response> {
  const [engine, awaiting, failed, pending, recent] = await Promise.all([
    store.getMeta<Record<string, unknown>>('engine').catch(() => null),
    store.findByStatus('awaiting_review', 50), store.findByStatus('failed', 50), store.findByStatus('pending', 50), store.findRecentSubmissions(24 * 7),
  ]);
  const section = (title: string, rows: ReportDoc[]) => `<h2>${title} <small>(${rows.length})</small></h2>${rows.length ? `<table><tr><th>id</th><th>category</th><th>address</th><th>description</th><th></th><th>status</th><th>city</th><th>created</th><th></th></tr>${rows.map((r) => row(r, token)).join('')}</table>` : '<p>none</p>'}`;
  const html = `<!doctype html><meta name="viewport" content="width=device-width"><title>SnapPVD ops</title>
<style>body{font:14px system-ui;margin:20px;max-width:1200px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left;vertical-align:top;font-size:13px}button{font:inherit;padding:4px 8px}code{font-size:12px}h2{margin-top:28px}</style>
<h1>SnapPVD ops</h1><p>Engine: paused=<b>${esc(engine?.['paused'] ?? false)}</b> · consecutiveFailures=${esc(engine?.['consecutiveFailures'] ?? 0)} · HITL_MODE=${esc(env.HITL_MODE)}
${engine?.['paused'] ? `<form method="post" action="/admin/action" style="display:inline"><input type="hidden" name="token" value="${esc(token)}"><input type="hidden" name="action" value="resume"><button>▶ Resume engine</button></form>` : ''}</p>
${section('Awaiting review', awaiting)}${section('Failed', failed)}${section('Pending', pending)}${section('Submitted (7d)', recent)}`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

export async function adminAction(env: Env, store: Store, request: Request): Promise<Response> {
  const form = await request.formData();
  const token = String(form.get('token') ?? ''); const id = String(form.get('id') ?? ''); const action = String(form.get('action') ?? '');
  if (token !== env.CANARY_TOKEN) return new Response('unauthorized', { status: 401 });
  if (action === 'resume') await store.setMeta('engine', { paused: false, consecutiveFailures: 0 });
  else if (action === 'approve') await approve(store, id, 'admin');
  else if (action === 'reject') await reject(store, id, 'admin');
  else if (action === 'requeue') await store.requeueReport(id, 0, 'Requeued from admin', new Date().toISOString());
  else return new Response('bad action', { status: 400 });
  return Response.redirect(new URL(`/admin?token=${encodeURIComponent(token)}`, request.url).toString(), 303);
}
