import { initFirestore } from './firestore.js';
import { FieldValue } from 'firebase-admin/firestore';

const db = initFirestore();

const report = {
  timestamp: FieldValue.serverTimestamp(),
  category: 'unshoveled_sidewalk',
  address: '100 Dorrance St, Providence, RI',
  lat: 41.8236,
  lng: -71.4133,
  description: 'Sidewalk completely unshoveled, forcing pedestrians into the street.',
  photo: null,
  reporterName: null,
  reporterEmail: null,
  status: 'pending',
  statusDetail: null,
  portalCaseId: null,
  statusUpdatedAt: null,
};

const ref = await db.collection('reports').add(report);
console.log(`Test report created: ${ref.id}`);
process.exit(0);
