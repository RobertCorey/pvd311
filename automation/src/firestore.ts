import { initializeApp, cert, type ServiceAccount } from 'firebase-admin/app';
import { getFirestore, type Firestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import { config } from './config.js';
import type { Report, ReportStatus } from '../../shared/types.js';

let db: Firestore;

// ── In-memory cache to reduce Firestore reads ──
const CACHE_TTL_MS = 60_000; // 60 seconds
let allReportsCache: { data: (Report & { id: string })[]; ts: number } | null = null;
let pendingCache: { data: (Report & { id: string })[]; ts: number } | null = null;

/** Invalidate caches (call after any status update so next read is fresh). */
export function invalidateCache(): void {
  allReportsCache = null;
  pendingCache = null;
}

export function initFirestore(): Firestore {
  const serviceAccount = JSON.parse(
    readFileSync(config.firebaseServiceAccountPath, 'utf-8')
  ) as ServiceAccount;

  initializeApp({ credential: cert(serviceAccount) });
  db = getFirestore();
  return db;
}

/** Fetch recent reports, newest first (capped at 200, cached 60s). */
export function getDb() { return db; }

export async function fetchAllReports(): Promise<(Report & { id: string })[]> {
  if (allReportsCache && Date.now() - allReportsCache.ts < CACHE_TTL_MS) {
    return allReportsCache.data;
  }

  const snapshot = await db
    .collection('reports')
    .orderBy('timestamp', 'desc')
    .limit(200)
    .get();

  const data = snapshot.docs.map((doc) => ({
    ...(doc.data() as Report),
    id: doc.id,
  }));

  allReportsCache = { data, ts: Date.now() };
  return data;
}

/** Fetch a single report by ID. */
export async function fetchReport(id: string): Promise<(Report & { id: string }) | null> {
  const doc = await db.collection('reports').doc(id).get();
  if (!doc.exists) return null;
  return { ...(doc.data() as Report), id: doc.id };
}

/** Fetch pending reports ordered oldest-first (FIFO, cached 60s). */
export async function fetchPendingReports(): Promise<(Report & { id: string })[]> {
  if (pendingCache && Date.now() - pendingCache.ts < CACHE_TTL_MS) {
    return pendingCache.data;
  }

  const snapshot = await db
    .collection('reports')
    .where('status', '==', 'pending')
    .get();

  const data = snapshot.docs.map((doc) => ({
    ...(doc.data() as Report),
    id: doc.id,
  }));

  data.sort((a, b) => {
    const aTime = a.timestamp?.seconds ?? 0;
    const bTime = b.timestamp?.seconds ?? 0;
    return aTime - bTime;
  });

  pendingCache = { data, ts: Date.now() };
  return data;
}

/** Reports stuck in 'processing' longer than N minutes (engine crashed mid-submit). */
export async function findStuckProcessing(minutes: number): Promise<(Report & { id: string })[]> {
  const cutoff = new Date(Date.now() - minutes * 60 * 1000);
  const snapshot = await db
    .collection('reports')
    .where('status', '==', 'processing')
    .where('statusUpdatedAt', '<=', Timestamp.fromDate(cutoff))
    .get();
  return snapshot.docs.map((doc) => ({ ...(doc.data() as Report), id: doc.id }));
}

/** Requeue a failed report for another attempt (draft bookkeeping is kept so the retry resumes the draft). */
export async function requeueReport(reportId: string, retries: number, detail: string, retryAfter: Date): Promise<void> {
  await db.collection('reports').doc(reportId).update({
    status: 'pending',
    statusDetail: detail,
    statusUpdatedAt: FieldValue.serverTimestamp(),
    retries,
    retryAfter: retryAfter.toISOString(),
  });
  invalidateCache();
}

// ── Engine state (survives restarts) ───────────────────────

export interface EngineState {
  paused: boolean;
  consecutiveFailures: number;
  submissionTimestamps: number[];
  lastSubmissionTime: number | null;
}

export async function loadEngineState(): Promise<EngineState | null> {
  const doc = await db.collection('meta').doc('engine').get().catch(() => null);
  return doc?.exists ? (doc.data() as EngineState) : null;
}

export async function saveEngineState(state: EngineState): Promise<void> {
  await db.collection('meta').doc('engine').set({ ...state, savedAt: new Date().toISOString() }, { merge: true }).catch((e) => console.error('[firestore] saveEngineState:', e));
}

/** Fetch submitted reports from the last N hours (for duplicate detection). */
export async function findRecentSubmissions(windowHours: number): Promise<(Report & { id: string })[]> {
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const snapshot = await db
    .collection('reports')
    .where('status', '==', 'submitted')
    .where('statusUpdatedAt', '>=', Timestamp.fromDate(cutoff))
    .get();

  return snapshot.docs.map((doc) => ({
    ...(doc.data() as Report),
    id: doc.id,
  }));
}

/** Update a report's status. */
export async function updateReportStatus(
  reportId: string,
  status: ReportStatus,
  detail?: string,
  portalCaseId?: string
): Promise<void> {
  const update: Record<string, unknown> = {
    status,
    statusDetail: detail || null,
    statusUpdatedAt: FieldValue.serverTimestamp(),
  };
  if (portalCaseId) {
    update['portalCaseId'] = portalCaseId;
  }
  if (status === 'submitted') {
    update['portalDraft'] = null; // draft is now a real case
  }
  await db.collection('reports').doc(reportId).update(update);
  invalidateCache();
}

/** Persist wizard draft bookkeeping so a retry resumes the same portal draft instead of orphaning a new one. */
export async function saveReportDraft(reportId: string, draft: NonNullable<Report['portalDraft']>): Promise<void> {
  await db.collection('reports').doc(reportId).update({ portalDraft: draft });
  invalidateCache();
}
