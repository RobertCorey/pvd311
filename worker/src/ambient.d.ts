// shared/types.ts references the firebase-admin global namespace; in the Worker, Firestore REST timestamps
// are decoded to this minimal shape.
declare namespace FirebaseFirestore {
  interface Timestamp { seconds: number; nanoseconds: number; toDate?(): Date }
}
