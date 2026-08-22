import 'dotenv/config';

function required(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val;
}

export const config = {
  firebaseServiceAccountPath: required('FIREBASE_SERVICE_ACCOUNT_PATH'),
  portalEmail: required('PORTAL_EMAIL'),
  portalPassword: required('PORTAL_PASSWORD'),
  portalBaseUrl: 'https://311.providenceri.gov',
  headless: process.env['HEADLESS'] === 'true',
  appName: process.env['APP_NAME'] || 'PVD311 app',

  // Portal "how would you like to receive updates": 585680002 Email, 585680000 Phone,
  // 585680001 Text, 585680003 No Contact Necessary, 585680004 Portal Comment.
  // Stays "No Contact" until the relay inbox exists (M6).
  portalNotificationMethod: process.env['PORTAL_NOTIFICATION_METHOD'] || '585680003',

  // Agent scout (fills unmapped Step-3 fields). Needs ANTHROPIC_API_KEY (read by the SDK).
  scoutModel: process.env['SCOUT_MODEL'] || 'claude-opus-5',
  scoutMinConfidence: parseFloat(process.env['SCOUT_MIN_CONFIDENCE'] || '0.7'),

  // Human-in-the-loop: 'review' (launch mode) | 'ramp' | 'auto'
  hitlMode: (process.env['HITL_MODE'] || 'review') as 'review' | 'ramp' | 'auto',
  trustRampN: parseInt(process.env['TRUST_RAMP_N'] || '3', 10),
  telegramBotToken: process.env['TELEGRAM_BOT_TOKEN'] || '',
  telegramChatId: process.env['TELEGRAM_CHAT_ID'] || '7744052689',
  port: parseInt(process.env['PORT'] || '3311', 10),

  // Auto-submission mode
  autoMode: process.argv.includes('--auto'),
  autoPollIntervalMs: 60_000,          // Check for pending reports every 60s
  autoSubmissionDelayMs: 45_000,       // Minimum gap between submissions
  autoMaxPerHour: 15,                  // Max submissions per rolling hour
  autoCircuitBreakerThreshold: 3,      // Pause after N consecutive failures
  watcherIntervalMs: parseInt(process.env['WATCHER_INTERVAL_MS'] || String(30 * 60_000), 10),
  autoStuckProcessingMinutes: 20,      // Reap reports stuck in 'processing' after N minutes
  autoMaxRetries: 2,                   // Automatic retries per report (non-human errors only)
  autoRetryBackoffMs: 10 * 60_000,     // Wait before a retry
  autoDuplicateWindowHours: 24,        // Duplicate detection window
  autoDuplicateDistanceMeters: 50,     // Haversine distance threshold

  // Address blocklist (substring match, case-insensitive)
  blockedAddresses: (process.env['BLOCKED_ADDRESSES'] || 'congdon st,congdon street')
    .split(',').map(s => s.trim()).filter(Boolean),
};
