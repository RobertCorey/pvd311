// Firestore/Storage rules tests. Run: npm run test:rules  (starts the emulators)
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { serverTimestamp, collection, doc, addDoc, getDoc, getDocs, updateDoc, setDoc, deleteDoc, writeBatch, Timestamp } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { CATEGORIES } from '../../shared/categories.ts';

const env = await initializeTestEnvironment({
  projectId: 'pvd311-rules-test',
  firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
  storage: { rules: readFileSync('storage.rules', 'utf8'), host: '127.0.0.1', port: 9199 },
});

const good = (uid, over = {}) => ({
  timestamp: serverTimestamp(), category: 'pothole', address: '25 Dorrance St', lat: 41.8236, lng: -71.4128,
  description: 'test', extra: { size: 'Medium (~28in)' }, photo: null, reporterName: null, reporterEmail: null,
  status: 'pending', statusDetail: null, portalCaseId: null, statusUpdatedAt: null, reporterUid: uid, ...over,
});

// The PWA creates a report and bumps users/{uid}.lastReportAt in one batch (pacing rule).
function create(ctx, data, { uidDoc = data.reporterUid, paceDoc = true } = {}) {
  const fs = ctx.firestore();
  const b = writeBatch(fs);
  b.set(doc(collection(fs, 'reports')), data);
  if (paceDoc) b.set(doc(fs, 'users', uidDoc), { lastReportAt: serverTimestamp() });
  return b.commit();
}
async function clearUsers() { await env.withSecurityRulesDisabled(async (c) => { for (const u of ['anon-1', 'anon-2']) await deleteDoc(doc(c.firestore(), 'users', u)); }); }

let pass = 0; const failures = []; const gaps = [];
async function gap(name, fn) { await clearUsers(); try { await fn(); pass++; } catch (e) { gaps.push(name); } }
async function t(name, fn) { await clearUsers(); try { await fn(); pass++; } catch (e) { failures.push(`${name}: ${e.message.split('\n')[0]}`); } }

const anon = env.authenticatedContext('anon-1', { firebase: { sign_in_provider: 'anonymous' } });
const other = env.authenticatedContext('anon-2', { firebase: { sign_in_provider: 'anonymous' } });
const nobody = env.unauthenticatedContext();
const reports = (ctx) => collection(ctx.firestore(), 'reports');

await t('rules category list matches shared/categories.ts', async () => {
  const rules = readFileSync('firestore.rules', 'utf8');
  const inRules = [...rules.matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
  for (const k of Object.keys(CATEGORIES)) assert.ok(inRules.includes(k), `missing ${k} in firestore.rules isCategory()`);
});
await t('anon create valid report', () => assertSucceeds(create(anon, good('anon-1'))));
await t('unauthenticated create denied', () => assertFails(create(nobody, good('anon-1'))));
await t('uid mismatch denied', () => assertFails(create(anon, good('anon-2'), { uidDoc: 'anon-1' })));
await t('create without pacing doc denied', () => assertFails(create(anon, good('anon-1'), { paceDoc: false })));
await t('pacing: second report within 3 min denied', async () => {
  await assertSucceeds(create(anon, good('anon-1')));
  await assertFails(create(anon, good('anon-1')));
});
await t('pacing: report allowed after 3 min', async () => {
  await env.withSecurityRulesDisabled((c) => setDoc(doc(c.firestore(), 'users', 'anon-1'), { lastReportAt: Timestamp.fromMillis(Date.now() - 4 * 60 * 1000) }));
  await assertSucceeds(create(anon, good('anon-1')));
});
await t('users doc: cannot write other fields', () => assertFails(setDoc(doc(anon.firestore(), 'users', 'anon-1'), { lastReportAt: serverTimestamp(), admin: true })));
await t('users doc: cannot write other uid', () => assertFails(setDoc(doc(anon.firestore(), 'users', 'anon-2'), { lastReportAt: serverTimestamp() })));
await t('client timestamp denied', () => assertFails(create(anon, good('anon-1', { timestamp: new Date() }))));
await t('bad category denied', () => assertFails(create(anon, good('anon-1', { category: 'snow' }))));
await t('status must be pending', () => assertFails(create(anon, good('anon-1', { status: 'submitted' }))));
await t('portalCaseId must be null', () => assertFails(create(anon, good('anon-1', { portalCaseId: 'PVD2026-1' }))));
await t('unknown field denied', () => assertFails(create(anon, good('anon-1', { approvedAt: 'x' }))));
await t('out-of-bbox denied', () => assertFails(create(anon, good('anon-1', { lat: 42.36, lng: -71.06 }))));
await t('null lat/lng ok (manual address)', () => assertSucceeds(create(anon, good('anon-1', { lat: null, lng: null }))));
await t('half-null lat/lng denied', () => assertFails(create(anon, good('anon-1', { lat: null }))));
await t('non-storage photo URL denied', () => assertFails(create(anon, good('anon-1', { photo: 'https://evil.example/x.jpg' }))));
await t('storage photo URL ok', () => assertSucceeds(create(anon, good('anon-1', { photo: 'https://firebasestorage.googleapis.com/v0/b/x/o/reports%2Fanon-1%2Fa.jpg?alt=media&token=t' }))));
await t('data: URL photo denied', () => assertFails(create(anon, good('anon-1', { photo: 'data:image/jpeg;base64,AAAA' }))));
await t('long description denied', () => assertFails(create(anon, good('anon-1', { description: 'x'.repeat(2001) }))));
await t('short address denied', () => assertFails(create(anon, good('anon-1', { address: 'ab' }))));
await t('extra too many keys denied', () => assertFails(create(anon, good('anon-1', { extra: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 'v'])) }))));
await t('queuedAt number ok', () => assertSucceeds(create(anon, good('anon-1', { queuedAt: 1700000000000 }))));
await t('no client list of all reports', () => assertFails(getDocs(reports(anon))));
await t('no client updates', async () => {
  let id; await env.withSecurityRulesDisabled(async (c) => { const r = await addDoc(collection(c.firestore(), 'reports'), good('anon-1')); id = r.id; });
  await assertFails(updateDoc(doc(reports(anon), id), { status: 'submitted' }));
  await assertFails(deleteDoc(doc(reports(anon), id)));
  await assertSucceeds(getDoc(doc(reports(anon), id)));
  await assertFails(getDoc(doc(reports(other), id)));
});
await t('meta collection locked', () => assertFails(setDoc(doc(anon.firestore(), 'meta', 'engine'), { x: 1 })));

// Storage
const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
await t('storage: owner upload ok + read back', async () => {
  const r = ref(anon.storage(), 'reports/anon-1/abc.jpg');
  await assertSucceeds(uploadBytes(r, jpg, { contentType: 'image/jpeg' }));
  await assertSucceeds(getDownloadURL(r));
});
await t('storage: other uid cannot read', () => assertFails(getDownloadURL(ref(other.storage(), 'reports/anon-1/abc.jpg'))));
await t('storage: wrong folder denied', () => assertFails(uploadBytes(ref(anon.storage(), 'reports/anon-2/x.jpg'), jpg, { contentType: 'image/jpeg' })));
await t('storage: non-image denied', () => assertFails(uploadBytes(ref(anon.storage(), 'reports/anon-1/x.jpg'), jpg, { contentType: 'text/html' })));
await t('storage: unauthenticated denied', () => assertFails(uploadBytes(ref(nobody.storage(), 'reports/anon-1/y.jpg'), jpg, { contentType: 'image/jpeg' })));
await t('storage: legacy root path denied', () => assertFails(uploadBytes(ref(anon.storage(), 'photos/x.jpg'), jpg, { contentType: 'image/jpeg' })));
await t('storage: oversize denied', () => assertFails(uploadBytes(ref(anon.storage(), 'reports/anon-1/big.jpg'), new Uint8Array(5 * 1024 * 1024 + 1), { contentType: 'image/jpeg' })));

await env.cleanup();
console.log(`rules tests: ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log('  FAIL ' + f);
if (gaps.length) console.log(`hardening gaps (not enforced by current rules, not fatal): ${gaps.join('; ')}`);
process.exit(failures.length ? 1 : 0);
