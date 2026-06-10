# API Reference

## @pgfire/client

### Initialization

```typescript
import { PgFireClient } from '@pgfire/client';

const client = new PgFireClient({
  server: {
    url: 'https://my-pgfire-server.example.com',
    token: 'jwt-token-here',
  },
});
```

### Collection Operations

```typescript
const users = client.collection<User>('users');

// Get a document
const user = await users.doc('abc123').get();
user.id;       // 'abc123'
user.exists;   // boolean
user.data();   // User | undefined
user.get('name');           // dot-notation: 'name'
user.get('profile.city');   // nested: 'profile.city'

// Add a new document (auto-generated ID)
const ref = await users.add({ name: 'Alice', age: 30 });

// Set with specific ID
await users.doc('my-id').set({ name: 'Bob', age: 25 });

// Set with merge (partial update)
await users.doc('my-id').set({ status: 'active' }, { merge: true });

// Update specific fields
await users.doc('my-id').update({ age: 31, 'profile.city': 'Taipei' });

// Delete
await users.doc('my-id').delete();
```

### Querying

```typescript
// Chainable query API
const snapshot = await users
  .where('age', '>', 18)
  .where('status', '==', 'active')
  .orderBy('age', 'desc')
  .limit(10)
  .get();

snapshot.size;       // number
snapshot.empty;      // boolean
snapshot.docs;       // QueryDocumentSnapshot[]
snapshot.forEach(doc => console.log(doc.id, doc.data()));
snapshot.docChanges(); // DocumentChange[]
```

### Real-time Subscription

```typescript
const unsubscribe = users
  .where('age', '>', 18)
  .onSnapshot(
    (snapshot) => {
      snapshot.docChanges().forEach(change => {
        console.log(change.type);  // 'added' | 'modified' | 'removed'
        console.log(change.doc.data());
      });
    },
    (error) => console.error('Subscription error:', error),
  );

// Cancel subscription
unsubscribe();

// Close all connections
await client.terminate();
```

### Supported Operators

| Operator | Example | Description |
|---|---|---|
| `==` | `.where('status', '==', 'active')` | Equal |
| `!=` | `.where('status', '!=', 'deleted')` | Not equal |
| `<` | `.where('age', '<', 65)` | Less than |
| `<=` | `.where('age', '<=', 64)` | Less than or equal |
| `>` | `.where('age', '>', 18)` | Greater than |
| `>=` | `.where('age', '>=', 18)` | Greater than or equal |
| `in` | `.where('status', 'in', ['active', 'pending'])` | In array |
| `not-in` | `.where('status', 'not-in', ['deleted'])` | Not in array |
| `array-contains` | `.where('tags', 'array-contains', 'premium')` | Array contains value |
| `array-contains-any` | `.where('tags', 'array-contains-any', ['a', 'b'])` | Array contains any |

### FieldValue Sentinels

```typescript
import { increment, arrayUnion, arrayRemove, serverTimestamp, deleteField } from '@pgfire/client';

doc.update({
  views: increment(1),
  tags: arrayUnion('new-tag'),
  oldTags: arrayRemove('old-tag'),
  updatedAt: serverTimestamp(),
  deprecatedField: deleteField(),
});
```

## @pgfire/embedded

```typescript
import { PgFireEmbedded } from '@pgfire/embedded';

const db = new PgFireEmbedded({
  host: 'localhost',
  port: 5432,
  database: 'mydb',
  user: 'postgres',
  password: 'secret',
});

await db.initialize();

// API is identical to client mode
const users = db.collection<User>('users');
const snapshot = await users.where('age', '>', 18).get();

await db.close();
```

## @pgfire/server

```typescript
import { PgFireServer } from '@pgfire/server';

const server = new PgFireServer({
  port: 3000,
  db: {
    host: 'localhost',
    port: 5432,
    database: 'mydb',
    user: 'postgres',
    password: 'secret',
  },
  auth: {
    secret: 'my-jwt-secret',
    tokenExpiry: '1h',
  },
  cors: { origin: '*' },
});

await server.start();

// Or attach to existing HTTP server
server.attachToServer(existingHttpServer);
```

## TypeScript Types

```typescript
interface CollectionReference<T = DocumentData> {
  readonly id: string;
  readonly path: string;
  doc(id?: string): DocumentReference<T>;
  add(data: T): Promise<DocumentReference<T>>;
  where(field: string, op: WhereFilterOp, value: any): Query<T>;
  orderBy(field: string, direction?: OrderByDirection): Query<T>;
  limit(n: number): Query<T>;
  get(): Promise<QuerySnapshot<T>>;
  onSnapshot(callback: (snap: QuerySnapshot<T>) => void, onError?: (e: Error) => void): Unsubscribe;
}

interface DocumentReference<T = DocumentData> {
  readonly id: string;
  readonly path: string;
  get(): Promise<DocumentSnapshot<T>>;
  set(data: T, options?: SetOptions): Promise<void>;
  update(data: Partial<T>): Promise<void>;
  delete(): Promise<void>;
  onSnapshot(callback: (snap: DocumentSnapshot<T>) => void, onError?: (e: Error) => void): Unsubscribe;
}

interface Query<T = DocumentData> {
  where(field: string, op: WhereFilterOp, value: any): Query<T>;
  orderBy(field: string, direction?: OrderByDirection): Query<T>;
  limit(n: number): Query<T>;
  get(): Promise<QuerySnapshot<T>>;
  onSnapshot(callback: (snap: QuerySnapshot<T>) => void, onError?: (e: Error) => void): Unsubscribe;
}

interface QuerySnapshot<T = DocumentData> {
  readonly docs: QueryDocumentSnapshot<T>[];
  readonly size: number;
  readonly empty: boolean;
  forEach(callback: (doc: QueryDocumentSnapshot<T>) => void): void;
  docChanges(): DocumentChange<T>[];
}

interface DocumentSnapshot<T = DocumentData> {
  readonly id: string;
  readonly exists: boolean;
  data(): T | undefined;
  get(field: string): any;
}

interface DocumentChange<T = DocumentData> {
  readonly type: 'added' | 'modified' | 'removed';
  readonly doc: QueryDocumentSnapshot<T>;
  readonly oldIndex: number;
  readonly newIndex: number;
}
```