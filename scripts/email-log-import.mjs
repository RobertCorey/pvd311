#!/usr/bin/env node
// One-off: import Resend's sent-mail history (with bodies, links redacted) into the email log (Firestore emails/*).
// The Worker's Resend key is send-only, so history comes from here, with a full-access key:
//   RESEND_API_KEY=re_… node scripts/email-log-import.mjs
// Firestore access: the firebase CLI login (~/.config/configstore/firebase-tools.json). Idempotent: existing records
// only get a missing body and the delivery state.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const { record, redact, toText, inferKind, caseIdIn, newOutId } = await import(new URL('../worker/src/emaillog.ts', import.meta.url).href);

const PROJECT = 'pvd-snow-report';
const env = { NOTIFY_EMAIL: 'rob@fixmypvd.org', CITY_SENDER_DOMAINS: 'providenceri.gov' };
const KEY = process.env.RESEND_API_KEY;
if (!KEY) throw new Error('RESEND_API_KEY (full access) required');

const cfg = JSON.parse(readFileSync(`${homedir()}/.config/configstore/firebase-tools.json`, 'utf8'));
// The firebase CLI's own (public, installed-app) OAuth client, read from the installed firebase-tools.
const { createRequire } = await import('node:module');
const fbApi = createRequire(import.meta.url)(process.env.FIREBASE_TOOLS_API ?? '/usr/lib/node_modules/firebase-tools/lib/api.js');
const tok = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({
  client_id: fbApi.clientId(), client_secret: fbApi.clientSecret(), grant_type: 'refresh_token', refresh_token: cfg.tokens.refresh_token }) })).json();
const auth = { authorization: `Bearer ${tok.access_token}` };
const base = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

const enc = (v) => v === null || v === undefined ? { nullValue: null } : typeof v === 'string' ? { stringValue: v } : typeof v === 'number' ? { integerValue: String(v) }
  : typeof v === 'boolean' ? { booleanValue: v } : v instanceof Date ? { timestampValue: v.toISOString() } : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } }
  : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
async function patch(id, fields) {
  const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
  const qs = keys.map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const body = { fields: Object.fromEntries(keys.map((k) => [k, enc(k === 'at' ? new Date(fields[k]) : fields[k])])) };
  const r = await fetch(`${base}/emails/${id}?${qs}`, { method: 'PATCH', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`PATCH ${id}: ${r.status} ${await r.text()}`);
}
async function get(id) {
  const r = await fetch(`${base}/emails/${id}`, { headers: auth });
  return r.ok ? (await r.json()).fields ?? {} : null;
}
const reportByCase = new Map();
async function reportFor(caseId) {
  if (!caseId) return null;
  if (reportByCase.has(caseId)) return reportByCase.get(caseId);
  const r = await fetch(`${base}:runQuery`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ structuredQuery: {
    from: [{ collectionId: 'reports' }], where: { fieldFilter: { field: { fieldPath: 'portalCaseId' }, op: 'EQUAL', value: { stringValue: caseId } } }, limit: 1 } }) });
  const rows = await r.json();
  const id = rows?.[0]?.document?.name?.split('/').pop() ?? null;
  reportByCase.set(caseId, id);
  return id;
}
const rs = async (path) => { const r = await fetch(`https://api.resend.com${path}`, { headers: { authorization: `Bearer ${KEY}` } }); if (!r.ok) throw new Error(`Resend ${r.status} ${path}`); return r.json(); };
const iso = (s) => new Date(Date.parse(s.replace(' ', 'T').replace(/\+00$/, 'Z'))).toISOString();

let after = '', created = 0, filled = 0, seen = 0;
for (let page = 0; page < 50; page++) {
  const list = await rs(`/emails?limit=100${after ? `&after=${after}` : ''}`);
  for (const it of list.data) {
    seen++;
    const id = newOutId(it.id);
    const have = await get(id);
    const full = await rs(`/emails/${it.id}`);
    const text = redact((full.text && full.text.trim()) || (full.html ? toText(full.html) : ''));
    if (have) {
      const imported = have.source?.stringValue === 'import'; // a live record's kind came from the code that sent it — keep it
      await patch(id, { ...(have.text && !('nullValue' in have.text) ? {} : { text }), ...(imported ? { kind: inferKind(it.subject, it.to.map((a) => a.toLowerCase()), env) } : {}),
        lastEvent: it.last_event ?? null, lastEventAt: new Date().toISOString() });
      filled++;
      continue;
    }
    const to = it.to.map((a) => a.toLowerCase());
    const caseId = caseIdIn(it.subject);
    const r = record({ id, at: iso(it.created_at), dir: 'out', kind: inferKind(it.subject, to, env), from: it.from, to, subject: it.subject, text,
      status: 'sent', resendId: it.id, lastEvent: it.last_event ?? null, lastEventAt: new Date().toISOString(), reportId: await reportFor(caseId), caseId,
      replyTo: full.reply_to?.[0] ?? null, source: 'import' });
    await patch(id, r);
    created++;
  }
  if (!list.has_more || !list.data.length) break;
  after = list.data[list.data.length - 1].id;
}
console.log(JSON.stringify({ seen, created, updatedExisting: filled }));
