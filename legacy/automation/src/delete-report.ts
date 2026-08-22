import { initFirestore } from './firestore.js';

const db = initFirestore();
const id = process.argv[2];
if (!id) { console.error('Usage: node delete-report.js <id>'); process.exit(1); }
await db.collection('reports').doc(id).delete();
console.log(`Deleted: ${id}`);
process.exit(0);
