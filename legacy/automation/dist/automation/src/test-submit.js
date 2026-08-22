/**
 * Dev tool: walk the portal wizard for a category WITHOUT Firestore.
 *   node dist/automation/src/test-submit.js <category> [inspect|live] [--resume]
 * inspect (default) stops before Submit (costs ONE portal draft). --resume re-enters the draft
 * saved by the previous run (.test-draft.json) instead of creating a new one.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { PortalSubmitter } from './portal.js';
import { CATEGORIES } from '../../shared/types.js';
const [category = 'pothole', modeArg = 'inspect'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const resume = process.argv.includes('--resume');
const mode = modeArg === 'live' ? 'live' : 'inspect';
if (!CATEGORIES[category]) {
    console.error(`Unknown category ${category}. Known: ${Object.keys(CATEGORIES).join(', ')}`);
    process.exit(1);
}
const DRAFT_FILE = '.test-draft.json';
const savedRaw = resume && existsSync(DRAFT_FILE) ? JSON.parse(readFileSync(DRAFT_FILE, 'utf8')) : null;
const saved = savedRaw?.category === category ? savedRaw : null;
const report = {
    id: `test-${Date.now()}`,
    timestamp: null,
    category,
    address: '25 Dorrance St, Providence, RI',
    lat: 41.8240, lng: -71.4128,
    description: 'TEST — generic submitter dry run. Please disregard.',
    photo: null,
    extra: { size: 'Medium (~28in)', animalType: 'Wildlife', vehicleDetails: 'Test vehicle details' },
    portalDraft: saved?.draft ?? null,
    reporterName: null, reporterEmail: null,
    status: 'pending', statusDetail: null, portalCaseId: null, statusUpdatedAt: null,
};
const portal = new PortalSubmitter();
await portal.launch();
try {
    const result = await portal.submitReport(report, {
        mode,
        onDraft: async (draft) => { writeFileSync(DRAFT_FILE, JSON.stringify({ category, draft }, null, 2)); console.log(`[test] draft saved (step ${draft.step}) entity=${draft.entityId}`); },
    });
    console.log('[test] RESULT', JSON.stringify({ ...result, controls: result.controls?.map((c) => `${c.id}${c.required ? '*' : ''}[${c.tag}/${c.type}]`) }, null, 2));
}
finally {
    await portal.close();
}
