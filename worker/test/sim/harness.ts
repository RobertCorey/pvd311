/**
 * harness.ts — shared fixtures for the portal simulator tests.
 * Builds the stub Env, an in-memory AuthStore, and ReportDoc factories, mirroring how the
 * existing worker/test/*.test.ts construct their stubs.
 */
import type { AuthStore, Env, ReportDoc } from '../../src/contracts.js';

/** Env stub. The driver only reads PORTAL_BASE_URL/PORTAL_EMAIL/PORTAL_PASSWORD/APP_NAME/ANTHROPIC_API_KEY/BROWSER. */
export function makeEnv(portalBaseUrl: string, over: Partial<Env> = {}): Env {
  return {
    PORTAL_BASE_URL: portalBaseUrl,
    APP_NAME: 'PVD311 sim',
    PORTAL_EMAIL: 'test@pvdsnow.org',
    PORTAL_PASSWORD: 'hunter2',
    ANTHROPIC_API_KEY: '', // empty by default → the real scout fails loud (NEEDS_MAPPING) with no network
    BROWSER: {} as unknown as Fetcher, // unused: @cloudflare/playwright.launch is mocked in the test
    ...over,
  } as Env;
}

/** In-memory AuthStore — persists Playwright storageState across driver instances (for draft resume). */
export function memAuthStore(): AuthStore & { peek(): Record<string, unknown> | null } {
  let state: Record<string, unknown> | null = null;
  return {
    load: async () => state,
    save: async (s) => { state = s; },
    peek: () => state,
  };
}

const ts = (iso: string) => ({ seconds: Math.floor(Date.parse(iso) / 1000), nanoseconds: 0, toDate: () => new Date(iso) });

/** A valid ReportDoc; override per test. Defaults to a pothole with a mapped size and a tiny data-URL photo. */
export function makeReport(over: Partial<ReportDoc> = {}): ReportDoc {
  return {
    id: 'rpt' + Math.random().toString(36).slice(2, 10),
    timestamp: ts('2026-08-22T12:00:00Z') as any,
    category: 'pothole',
    address: '25 Dorrance St',
    lat: null,
    lng: null,
    description: 'Deep pothole in the right lane, been there two weeks.',
    photo: TINY_JPEG_DATA_URL,
    extra: { size: 'Large (~36in)' },
    reporterName: null,
    reporterEmail: 'r@example.com',
    status: 'pending',
    statusDetail: null,
    portalCaseId: null,
    statusUpdatedAt: null,
    ...over,
  } as ReportDoc;
}

/** 1x1 JPEG as a data URL so uploadPhoto()'s data: branch runs with no network fetch. */
export const TINY_JPEG_DATA_URL =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////' +
  '////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AfwD/2Q==';
