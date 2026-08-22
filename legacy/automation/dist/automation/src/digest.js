/** Daily digest to the phone: what happened in the last 24h. */
import { Timestamp } from 'firebase-admin/firestore';
import { getDb } from './firestore.js';
import { alert } from './telegram.js';
export async function sendDailyDigest() {
    const since = Timestamp.fromDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const snap = await getDb().collection('reports').where('statusUpdatedAt', '>=', since).get();
    const counts = {};
    for (const d of snap.docs) {
        const s = d.data()['status'] || '?';
        counts[s] = (counts[s] || 0) + 1;
    }
    const awaiting = (await getDb().collection('reports').where('status', '==', 'awaiting_review').get()).size;
    const failed = (await getDb().collection('reports').where('status', '==', 'failed').get()).size;
    const line = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ') || 'no activity';
    await alert(`📋 <b>Daily digest</b>\nLast 24h: ${line}\nQueue: ${awaiting} awaiting review, ${failed} failed`);
}
