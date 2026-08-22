/**
 * firestore.ts — Cloudflare Workers port of automation/src/firestore.ts.
 *
 * Talks to Firestore over the REST API v1 and to Firebase Storage over the JSON API v0, authenticated
 * with a Google service-account JWT (RS256, signed via WebCrypto — no Node crypto). The OAuth access
 * token is cached in module scope until ~5 min before expiry and shared across every Store instance
 * (one service account). Firestore's typed value model is encoded/decoded here so callers see plain JS
 * objects, with timestamps decoded to the {seconds, nanoseconds, toDate()} shape shared/types.ts expects.
 */
import type { Report, ReportStatus } from '../../shared/types.js';
import type { Store, AuthStore, Env, ReportDoc, PortalDraft } from './contracts.js';

// ── Service-account JWT → OAuth access token ───────────────────────────────
interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
  token_uri?: string;
}

const TOKEN_SCOPES = [
  'https://www.googleapis.com/auth/datastore',            // Firestore
  'https://www.googleapis.com/auth/devstorage.read_write', // Firebase Storage
].join(' ');

// Shared across Store instances (same service account per Worker).
let cachedToken: { token: string; expEpoch: number } | null = null;
let signingKey: { email: string; key: CryptoKey } | null = null;

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64urlFromBytes(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlJson(obj: unknown): string {
  return base64urlFromBytes(new TextEncoder().encode(JSON.stringify(obj)));
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  return crypto.subtle.importKey(
    'pkcs8',
    base64ToBytes(b64),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function getAccessToken(env: Env): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expEpoch - 300 > nowSec) return cachedToken.token;

  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT) as ServiceAccount;
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';

  if (!signingKey || signingKey.email !== sa.client_email) {
    signingKey = { email: sa.client_email, key: await importPrivateKey(sa.private_key) };
  }

  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope: TOKEN_SCOPES,
    aud: tokenUri,
    iat: nowSec,
    exp: nowSec + 3600,
  };
  const signingInput = `${base64urlJson(header)}.${base64urlJson(claim)}`;
  const sig = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    signingKey.key,
    new TextEncoder().encode(signingInput),
  );
  const jwt = `${signingInput}.${base64urlFromBytes(new Uint8Array(sig))}`;

  const resp = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!resp.ok) {
    throw new Error(`token exchange failed: ${resp.status} ${await resp.text()}`);
  }
  const json = (await resp.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: json.access_token, expEpoch: nowSec + json.expires_in };
  return json.access_token;
}

// ── Firestore typed-value model ────────────────────────────────────────────
type FsValue =
  | { stringValue: string }
  | { integerValue: string }
  | { doubleValue: number }
  | { booleanValue: boolean }
  | { nullValue: null }
  | { timestampValue: string }
  | { mapValue: { fields?: Record<string, FsValue> } }
  | { arrayValue: { values?: FsValue[] } }
  | { referenceValue: string }
  | { geoPointValue: { latitude: number; longitude: number } }
  | { bytesValue: string };

interface FsDocument {
  name: string;
  fields?: Record<string, FsValue>;
  createTime?: string;
  updateTime?: string;
}

interface DecodedTimestamp {
  seconds: number;
  nanoseconds: number;
  toDate(): Date;
}

function decodeTimestamp(iso: string): DecodedTimestamp {
  const ms = Date.parse(iso);
  const seconds = Math.floor(ms / 1000);
  let nanoseconds: number;
  const frac = iso.match(/\.(\d+)/);
  if (frac) {
    nanoseconds = parseInt((frac[1] + '000000000').slice(0, 9), 10);
  } else {
    nanoseconds = (ms - seconds * 1000) * 1_000_000;
  }
  return {
    seconds,
    nanoseconds,
    toDate: () => new Date(seconds * 1000 + Math.floor(nanoseconds / 1_000_000)),
  };
}

function decodeValue(v: FsValue): unknown {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return decodeTimestamp(v.timestampValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields ?? {});
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(decodeValue);
  if ('referenceValue' in v) return v.referenceValue;
  if ('geoPointValue' in v) return v.geoPointValue;
  if ('bytesValue' in v) return v.bytesValue;
  return null;
}

function decodeFields(fields: Record<string, FsValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = decodeValue(v);
  return out;
}

function isTimestampLike(val: object): val is { seconds: number; nanoseconds: number } {
  const t = val as { seconds?: unknown; nanoseconds?: unknown };
  return typeof t.seconds === 'number' && typeof t.nanoseconds === 'number';
}

function encodeValue(val: unknown): FsValue {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'string') return { stringValue: val };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  }
  if (val instanceof Date) return { timestampValue: val.toISOString() };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(encodeValue) } };
  if (typeof val === 'object') {
    // A decoded Firestore timestamp fed back in → re-encode as a timestamp.
    if (isTimestampLike(val)) {
      return {
        timestampValue: new Date(
          val.seconds * 1000 + Math.floor(val.nanoseconds / 1_000_000),
        ).toISOString(),
      };
    }
    return { mapValue: { fields: encodeFields(val as Record<string, unknown>) } };
  }
  return { nullValue: null };
}

function encodeFields(obj: Record<string, unknown>): Record<string, FsValue> {
  const out: Record<string, FsValue> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = encodeValue(v);
  }
  return out;
}

// ── Firestore REST helpers ─────────────────────────────────────────────────
function docBase(env: Env): string {
  return `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
}

async function authedFetch(env: Env, url: string, init: RequestInit): Promise<Response> {
  const token = await getAccessToken(env);
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  return fetch(url, { ...init, headers });
}

async function getDoc(env: Env, path: string): Promise<FsDocument | null> {
  const resp = await authedFetch(env, `${docBase(env)}/${path}`, { method: 'GET' });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`firestore GET ${path}: ${resp.status} ${await resp.text()}`);
  return (await resp.json()) as FsDocument;
}

/** Set a (possibly nested) leaf in a Firestore document `fields` body, creating intermediate maps. */
function setNestedField(root: Record<string, FsValue>, segments: string[], value: FsValue): void {
  const [head, ...rest] = segments;
  if (rest.length === 0) {
    root[head] = value;
    return;
  }
  let node = root[head];
  if (!node || !('mapValue' in node)) {
    node = { mapValue: { fields: {} } };
    root[head] = node;
  }
  const mv = node as { mapValue: { fields?: Record<string, FsValue> } };
  if (!mv.mapValue.fields) mv.mapValue.fields = {};
  setNestedField(mv.mapValue.fields, rest, value);
}

/**
 * PATCH with updateMask = the given keys. Firestore PATCH upserts, so this creates the doc if missing.
 * A key containing '.' is treated as a nested field path (e.g. 'review.decision'): only that leaf is
 * merged, sibling leaves of the parent map are preserved. A key with no '.' replaces that whole
 * top-level field. All our field names are simple identifiers, so no backtick escaping is needed.
 */
async function patchDoc(env: Env, path: string, fields: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
  if (keys.length === 0) return;
  const params = new URLSearchParams();
  const body: Record<string, FsValue> = {};
  for (const k of keys) {
    params.append('updateMask.fieldPaths', k);
    setNestedField(body, k.split('.'), encodeValue(fields[k]));
  }

  const resp = await authedFetch(env, `${docBase(env)}/${path}?${params.toString()}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fields: body }),
  });
  if (!resp.ok) throw new Error(`firestore PATCH ${path}: ${resp.status} ${await resp.text()}`);
}

interface StructuredQuery {
  from: { collectionId: string }[];
  where?: unknown;
  orderBy?: { field: { fieldPath: string }; direction: 'ASCENDING' | 'DESCENDING' }[];
  select?: { fields: { fieldPath: string }[] };
  limit?: number;
}

async function runQuery(env: Env, structuredQuery: StructuredQuery): Promise<FsDocument[]> {
  const resp = await authedFetch(env, `${docBase(env)}:runQuery`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ structuredQuery }),
  });
  if (!resp.ok) throw new Error(`firestore runQuery: ${resp.status} ${await resp.text()}`);
  const rows = (await resp.json()) as { document?: FsDocument }[];
  return rows.filter((r): r is { document: FsDocument } => !!r.document).map((r) => r.document);
}

async function runCount(env: Env, structuredQuery: StructuredQuery): Promise<number> {
  const resp = await authedFetch(env, `${docBase(env)}:runAggregationQuery`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      structuredAggregationQuery: {
        structuredQuery,
        aggregations: [{ alias: 'count', count: {} }],
      },
    }),
  });
  if (!resp.ok) throw new Error(`firestore runAggregationQuery: ${resp.status} ${await resp.text()}`);
  const rows = (await resp.json()) as { result?: { aggregateFields?: Record<string, FsValue> } }[];
  for (const row of rows) {
    const c = row.result?.aggregateFields?.count;
    if (c && 'integerValue' in c) return Number(c.integerValue);
  }
  return 0;
}

// Filter builders.
function fieldFilter(fieldPath: string, op: string, value: FsValue) {
  return { fieldFilter: { field: { fieldPath }, op, value } };
}
function andFilter(...filters: unknown[]) {
  return { compositeFilter: { op: 'AND', filters } };
}

function docToReport(doc: FsDocument): ReportDoc {
  const data = decodeFields(doc.fields ?? {}) as unknown as Report;
  const id = doc.name.split('/').pop() as string;
  return { ...data, id };
}

// ── Store ──────────────────────────────────────────────────────────────────
export function createStore(env: Env): Store {
  const reportPath = (id: string) => `reports/${id}`;

  return {
    async fetchPendingReports(): Promise<ReportDoc[]> {
      const docs = await runQuery(env, {
        from: [{ collectionId: 'reports' }],
        where: fieldFilter('status', 'EQUAL', { stringValue: 'pending' }),
      });
      const reports = docs.map(docToReport);
      // Oldest first (FIFO). statusUpdatedAt-style ordering is done client-side, matching the Admin SDK version.
      reports.sort((a, b) => (a.timestamp?.seconds ?? 0) - (b.timestamp?.seconds ?? 0));
      return reports;
    },

    async fetchReport(id: string): Promise<ReportDoc | null> {
      const doc = await getDoc(env, reportPath(id));
      return doc ? docToReport(doc) : null;
    },

    async updateReportStatus(id, status, detail, portalCaseId): Promise<void> {
      const fields: Record<string, unknown> = {
        status,
        statusDetail: detail || null,
        statusUpdatedAt: new Date(),
      };
      if (portalCaseId) fields.portalCaseId = portalCaseId;
      if (status === 'submitted') fields.portalDraft = null; // draft is now a real case
      await patchDoc(env, reportPath(id), fields);
    },

    async patchReport(id, fields): Promise<void> {
      await patchDoc(env, reportPath(id), fields);
    },

    async saveReportDraft(id, draft: PortalDraft): Promise<void> {
      await patchDoc(env, reportPath(id), { portalDraft: draft });
    },

    async requeueReport(id, retries, detail, retryAfterIso): Promise<void> {
      await patchDoc(env, reportPath(id), {
        status: 'pending',
        statusDetail: detail,
        statusUpdatedAt: new Date(),
        retries,
        retryAfter: retryAfterIso,
      });
    },

    async findStuckProcessing(minutes): Promise<ReportDoc[]> {
      const cutoff = new Date(Date.now() - minutes * 60_000);
      const docs = await runQuery(env, {
        from: [{ collectionId: 'reports' }],
        where: andFilter(
          fieldFilter('status', 'EQUAL', { stringValue: 'processing' }),
          fieldFilter('statusUpdatedAt', 'LESS_THAN_OR_EQUAL', { timestampValue: cutoff.toISOString() }),
        ),
        orderBy: [{ field: { fieldPath: 'statusUpdatedAt' }, direction: 'ASCENDING' }],
      });
      return docs.map(docToReport);
    },

    async findRecentSubmissions(hours): Promise<ReportDoc[]> {
      const cutoff = new Date(Date.now() - hours * 3_600_000);
      const docs = await runQuery(env, {
        from: [{ collectionId: 'reports' }],
        where: andFilter(
          fieldFilter('status', 'EQUAL', { stringValue: 'submitted' }),
          fieldFilter('statusUpdatedAt', 'GREATER_THAN_OR_EQUAL', { timestampValue: cutoff.toISOString() }),
        ),
        orderBy: [{ field: { fieldPath: 'statusUpdatedAt' }, direction: 'ASCENDING' }],
      });
      return docs.map(docToReport);
    },

    async findReportsSince(hoursAgo, limit): Promise<ReportDoc[]> {
      const cutoff = new Date(Date.now() - hoursAgo * 3_600_000);
      const docs = await runQuery(env, {
        from: [{ collectionId: 'reports' }],
        where: fieldFilter('timestamp', 'GREATER_THAN_OR_EQUAL', { timestampValue: cutoff.toISOString() }),
        orderBy: [{ field: { fieldPath: 'timestamp' }, direction: 'DESCENDING' }],
        limit,
      });
      return docs.map(docToReport).filter((r) => r.status !== 'rejected' && r.status !== 'auto-rejected');
    },

    async countSubmittedByCategory(category, limit): Promise<number> {
      // Two equality filters — served by single-field indexes (zigzag merge), no composite index needed.
      const docs = await runQuery(env, {
        from: [{ collectionId: 'reports' }],
        where: andFilter(
          fieldFilter('status', 'EQUAL', { stringValue: 'submitted' }),
          fieldFilter('category', 'EQUAL', { stringValue: category }),
        ),
        select: { fields: [{ fieldPath: '__name__' }] },
        limit,
      });
      return docs.length;
    },

    async listSubmittedWithCaseId(): Promise<ReportDoc[]> {
      const docs = await runQuery(env, {
        from: [{ collectionId: 'reports' }],
        where: fieldFilter('status', 'EQUAL', { stringValue: 'submitted' }),
      });
      return docs.map(docToReport).filter((r) => r.portalCaseId != null);
    },

    async countByStatus(status: ReportStatus): Promise<number> {
      return runCount(env, {
        from: [{ collectionId: 'reports' }],
        where: fieldFilter('status', 'EQUAL', { stringValue: status }),
      });
    },

    async getMeta<T>(docId: string): Promise<T | null> {
      const doc = await getDoc(env, `meta/${docId}`);
      return doc ? (decodeFields(doc.fields ?? {}) as T) : null;
    },

    async setMeta(docId, data): Promise<void> {
      await patchDoc(env, `meta/${docId}`, data);
    },

    async uploadFile(path, bytes, contentType, opts): Promise<string> {
      const token = await getAccessToken(env);
      const url =
        `https://firebasestorage.googleapis.com/v0/b/${env.STORAGE_BUCKET}/o` +
        `?uploadType=media&name=${encodeURIComponent(path)}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
        body: bytes,
      });
      if (!resp.ok) throw new Error(`storage upload ${path}: ${resp.status} ${await resp.text()}`);
      if (opts?.downloadToken) {
        // Firebase-style tokenized URL: unguessable, no auth needed (the portal submitter fetches it).
        const meta = await fetch(`https://firebasestorage.googleapis.com/v0/b/${env.STORAGE_BUCKET}/o/${encodeURIComponent(path)}`, {
          method: 'PATCH',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ metadata: { firebaseStorageDownloadTokens: opts.downloadToken } }),
        });
        if (!meta.ok) throw new Error(`storage metadata ${path}: ${meta.status}`);
        return `https://firebasestorage.googleapis.com/v0/b/${env.STORAGE_BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=${opts.downloadToken}`;
      }
      return `gs://${env.STORAGE_BUCKET}/${path}`;
    },
  };
}

// ── AuthStore (Playwright storageState persisted as JSON in meta/portalAuth) ──
export function createAuthStore(store: Store): AuthStore {
  return {
    async load(): Promise<Record<string, unknown> | null> {
      const meta = await store.getMeta<{ json?: string }>('portalAuth');
      if (!meta?.json) return null;
      try {
        return JSON.parse(meta.json) as Record<string, unknown>;
      } catch {
        return null;
      }
    },
    async save(state): Promise<void> {
      // Stored as a JSON string to round-trip Playwright storageState verbatim, sidestepping
      // Firestore's nested-map field-name and depth constraints.
      await store.setMeta('portalAuth', { json: JSON.stringify(state), savedAt: new Date().toISOString() });
    },
  };
}
