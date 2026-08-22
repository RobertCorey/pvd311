import { config } from './config.js';
import { fetchPendingReports, findRecentSubmissions, updateReportStatus, saveReportDraft } from './firestore.js';
import { PortalSubmitter } from './portal.js';
import { CATEGORIES, isCategory, type Report } from '../../shared/types.js';

// Providence bounding box
const PVD_BOUNDS = { minLat: 41.772, maxLat: 41.871, minLng: -71.473, maxLng: -71.370 };

export interface AutoLogEntry {
  time: string;
  reportId: string;
  action: 'submitted' | 'auto-rejected' | 'failed';
  detail: string;
}

export interface AutoState {
  enabled: boolean;
  paused: boolean; // circuit breaker tripped
  consecutiveFailures: number;
  submissionsThisHour: number;
  lastSubmissionTime: string | null;
  log: AutoLogEntry[];
}

export class AutoSubmitter {
  private enabled: boolean;
  private paused = false;
  private consecutiveFailures = 0;
  private submissionTimestamps: number[] = [];
  private lastSubmissionTime: number | null = null;
  private log: AutoLogEntry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  /** Callback so index.ts can check/set activeSubmission */
  constructor(
    private isSubmissionActive: () => boolean,
    private setSubmissionActive: (id: string | null) => void,
  ) {
    this.enabled = config.autoMode;
  }

  getState(): AutoState {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    return {
      enabled: this.enabled,
      paused: this.paused,
      consecutiveFailures: this.consecutiveFailures,
      submissionsThisHour: this.submissionTimestamps.filter(t => t > oneHourAgo).length,
      lastSubmissionTime: this.lastSubmissionTime ? new Date(this.lastSubmissionTime).toISOString() : null,
      log: this.log.slice(-50),
    };
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on && !this.timer) this.start();
    if (!on && this.timer) this.stop();
    console.log(`[auto] ${on ? 'Enabled' : 'Disabled'}`);
  }

  resume(): void {
    this.paused = false;
    this.consecutiveFailures = 0;
    this.enabled = true;
    if (!this.timer) this.start();
    console.log('[auto] Resumed (circuit breaker reset)');
  }

  start(): void {
    if (this.timer) return;
    console.log('[auto] Polling started');
    this.timer = setInterval(() => this.poll(), config.autoPollIntervalMs);
    // Run first poll immediately
    this.poll();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[auto] Polling stopped');
  }

  private addLog(reportId: string, action: AutoLogEntry['action'], detail: string): void {
    this.log.push({ time: new Date().toISOString(), reportId, action, detail });
    if (this.log.length > 50) this.log.shift();
  }

  private async poll(): Promise<void> {
    if (!this.enabled || this.paused || this.busy) return;
    if (this.isSubmissionActive()) return;

    // Rate limit: check hourly cap
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    this.submissionTimestamps = this.submissionTimestamps.filter(t => t > oneHourAgo);
    if (this.submissionTimestamps.length >= config.autoMaxPerHour) {
      console.log('[auto] Hourly rate limit reached, skipping poll');
      return;
    }

    // Minimum delay between submissions
    if (this.lastSubmissionTime && Date.now() - this.lastSubmissionTime < config.autoSubmissionDelayMs) {
      return;
    }

    this.busy = true;
    try {
      const pending = await fetchPendingReports();
      if (pending.length === 0) return;

      // Process first pending report
      const report = pending[0];
      const rejection = await this.verify(report);
      if (rejection) {
        await updateReportStatus(report.id, 'auto-rejected' as any, rejection);
        this.addLog(report.id, 'auto-rejected', rejection);
        console.log(`[auto] Rejected ${report.id}: ${rejection}`);
        return;
      }

      // Submit
      await this.submitReport(report);
    } catch (err) {
      console.error('[auto] Poll error:', err);
    } finally {
      this.busy = false;
    }
  }

  private async verify(report: Report & { id: string }): Promise<string | null> {
    // Gate 1: Valid category (checked first so later gates can read its config)
    if (!isCategory(report.category)) return `Invalid category: ${report.category}`;

    // Gate 2: Has photo, when the category requires one
    if (CATEGORIES[report.category].photoRequired !== false && !report.photo) return 'No photo attached';

    // Gate 2: Has address
    if (!report.address || !report.address.trim()) return 'No address';

    // Gate 3: Address blocklist (spam/abuse)
    const addr = report.address.trim().toLowerCase();
    for (const blocked of config.blockedAddresses) {
      if (addr.includes(blocked.toLowerCase())) {
        return `Blocked address: "${report.address}" matches "${blocked}"`;
      }
    }

    // Gate 5: If coordinates are present, verify they're inside Providence
    if (report.lat != null && report.lng != null) {
      if (
        report.lat < PVD_BOUNDS.minLat || report.lat > PVD_BOUNDS.maxLat ||
        report.lng < PVD_BOUNDS.minLng || report.lng > PVD_BOUNDS.maxLng
      ) {
        return `Outside Providence (${report.lat}, ${report.lng})`;
      }
    }

    // Gate 6: Duplicate check (only when both reports have coordinates)
    if (report.lat != null && report.lng != null) {
      const recent = await findRecentSubmissions(config.autoDuplicateWindowHours);
      for (const existing of recent) {
        if (existing.lat == null || existing.lng == null) continue;
        const dist = haversineMeters(report.lat, report.lng, existing.lat, existing.lng);
        if (dist < config.autoDuplicateDistanceMeters) {
          return `Duplicate: within ${Math.round(dist)}m of submitted report ${existing.id}`;
        }
      }
    }

    return null; // passed all gates
  }

  private async submitReport(report: Report & { id: string }): Promise<void> {
    const portal = new PortalSubmitter();
    this.setSubmissionActive(report.id);
    try {
      await updateReportStatus(report.id, 'processing', 'Auto-submission started');
      await portal.launch();
      const result = await portal.submitReport(report, { mode: 'live', onDraft: (d) => saveReportDraft(report.id, d) });

      await updateReportStatus(
        report.id,
        'submitted',
        result.caseId ? `Auto-submitted as ${result.caseId}` : 'Auto-submitted successfully',
        result.caseId,
      );

      this.submissionTimestamps.push(Date.now());
      this.lastSubmissionTime = Date.now();
      this.consecutiveFailures = 0;
      this.addLog(report.id, 'submitted', result.caseId || 'success');
      console.log(`[auto] Submitted ${report.id}${result.caseId ? ` as ${result.caseId}` : ''}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[auto] Failed ${report.id}:`, message);
      await updateReportStatus(report.id, 'failed', `Auto: ${message}`).catch(() => {});
      this.consecutiveFailures++;
      this.addLog(report.id, 'failed', message);

      if (this.consecutiveFailures >= config.autoCircuitBreakerThreshold) {
        this.paused = true;
        console.error(`[auto] Circuit breaker tripped after ${this.consecutiveFailures} consecutive failures`);
      }
    } finally {
      await portal.close();
      this.setSubmissionActive(null);
    }
  }
}

/** Haversine distance in meters between two lat/lng points. */
function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000; // Earth radius in meters
  const toRad = (deg: number) => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
