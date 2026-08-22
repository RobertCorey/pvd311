/**
 * Dev tool: run one status-watcher pass and print the changes.
 *   HEADLESS=true node dist/automation/src/test-watcher.js
 *
 * Reads portal credentials + Firebase service account from automation/.env (via config/dotenv).
 * Read-only on the portal: scrapes My Requests, diffs each submitted report's portal status against
 * the last recorded `portalStatus`, and persists {portalStatus, portalStatusUpdatedAt} on change.
 * Set WATCHER_ACTIVITY=true to also open the read-only Record-details flyout and capture activity.
 */
import { initFirestore } from './firestore.js';
import { runWatcher } from './watcher.js';
initFirestore();
const changes = await runWatcher();
if (!changes.length) {
    console.log('\n[test-watcher] No status changes this pass.');
}
else {
    console.log(`\n[test-watcher] ${changes.length} change(s):`);
    for (const c of changes) {
        const who = c.reporterEmail ? ` → notify ${c.reporterEmail}` : ' (no reporter email)';
        const act = c.activity ? ` | activity: "${c.activity.subject}" (${c.activity.createdOn ?? 'no date'})` : '';
        console.log(`  ${c.caseId} [report ${c.reportId}]: ${c.from ?? '(none)'} → ${c.to}${who}${act}`);
    }
}
console.log(JSON.stringify(changes, null, 2));
process.exit(0);
