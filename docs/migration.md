# Migration from Firestore

## Concept Mapping

| Firestore | PgFire |
|---|---|
| Firebase Project | PostgreSQL Database |
| Collection | PostgreSQL Table |
| Document | Row (with JSONB data column) |
| Document ID | `id` (TEXT PK) |
| Document Fields | JSONB keys (with optional generated columns) |
| Collection Group | Prefix-based table filtering |
| Security Rules | JWT + custom middleware |
| FieldValue sentinels | Built-in (increment, arrayUnion, etc.) |
| `onSnapshot()` | `onSnapshot()` (same API) |

## API Differences

### Same
- `collection().where().orderBy().limit()`
- `doc().get()`, `doc().set()`, `doc().update()`, `doc().delete()`
- `onSnapshot(callback)` with `docChanges()`
- `FieldValue.increment()`, `arrayUnion()`, etc.
- Query operators (`==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `array-contains`)

### Different
- No `.collectionGroup()` — use prefix filtering instead
- No `.startAfter()`, `.startAt()`, `.endBefore()`, `.endAt()` cursors (planned)
- No subcollections — use dot-notation paths in data (e.g., `'subitems.0.name'`)
- No automatic Composite Index management — create PostgreSQL indexes manually
- No offline persistence (coming in future versions)

## Data Export from Firestore

```typescript
import { Firestore } from 'firebase-admin';

// Export all documents from a Firestore collection
async function exportCollection(collectionName: string) {
  const firestore = new Firestore();
  const snapshot = await firestore.collection(collectionName).get();
  const docs = snapshot.docs.map(doc => ({
    id: doc.id,
    data: doc.data(),
  }));
  return docs;
}
```

## Data Import to PgFire

```typescript
import { PgFireEmbedded } from '@pgfire/embedded';

async function importCollection(db: PgFireEmbedded, name: string, docs: any[]) {
  const collection = db.collection(name);
  const results = [];
  for (const doc of docs) {
    await collection.doc(doc.id).set(doc.data);
    results.push(doc.id);
  }
  return results;
}
```