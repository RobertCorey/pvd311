/**
 * Delete all test/pending reports from Firestore.
 * Run: npx tsc && node dist/automation/src/cleanup.js
 */

import { initFirestore, fetchAllReports } from './firestore.js';
import { getFirestore } from 'firebase-admin/firestore';

const db = initFirestore();

async function main() {
  const reports = await fetchAllReports();
  if (reports.length === 0) {
    console.log('No reports found. Dashboard is clean.');
    return;
  }

  console.log(`Found ${reports.length} report(s):\n`);
  for (const r of reports) {
    console.log(`  ${r.id} | ${r.status} | ${r.category} | ${r.address}`);
  }

  console.log('\nDeleting all reports...');
  const batch = getFirestore().batch();
  for (const r of reports) {
    batch.delete(getFirestore().collection('reports').doc(r.id));
  }
  await batch.commit();
  console.log(`Deleted ${reports.length} report(s). Dashboard is clean.`);
}

main().catch((err) => {
  console.error('Cleanup failed:', err.message);
  process.exit(1);
});
