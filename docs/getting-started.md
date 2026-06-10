# Getting Started

## Installation

### Client Mode (browser/Node.js)

```bash
npm install @pgfire/client
```

### Server Mode

```bash
npm install @pgfire/server
```

### Embedded Mode (backend only)

```bash
npm install @pgfire/embedded
```

## Quick Start: Embedded Mode

The simplest way to get started. Requires a running PostgreSQL instance.

```typescript
import { PgFireEmbedded } from '@pgfire/embedded';

// 1. Initialize
const db = new PgFireEmbedded({
  host: 'localhost',
  port: 5432,
  database: 'mydb',
  user: 'postgres',
  password: 'secret',
});

await db.initialize();

// 2. Get a collection reference
const users = db.collection<{ name: string; age: number }>('users');

// 3. Add a document
const ref = await users.add({ name: 'Alice', age: 30 });
console.log('New doc ID:', ref.id);

// 4. Query documents
const snapshot = await users
  .where('age', '>', 18)
  .orderBy('age', 'desc')
  .get();

snapshot.forEach(doc => {
  console.log(doc.id, doc.data());
});

// 5. Subscribe to real-time changes
const unsubscribe = users
  .where('age', '>', 18)
  .onSnapshot((snapshot) => {
    console.log(`Got ${snapshot.size} documents`);
    snapshot.docChanges().forEach(change => {
      console.log(`${change.type}:`, change.doc.data());
    });
  });

// 6. Clean up
// unsubscribe();
// await db.close();
```

## Quick Start: Client-Server Mode

### Step 1: Start the server

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
    secret: 'my-secret-key',
    required: true,
  },
});

await server.start();
console.log('PgFire server running on :3000');
```

### Step 2: Generate a JWT token

```bash
npx pgfire auth token --secret my-secret-key --sub client1
```

### Step 3: Connect from the client

```typescript
import { PgFireClient } from '@pgfire/client';

const client = new PgFireClient({
  server: {
    url: 'http://localhost:3000',
    token: 'your-jwt-token-here',
  },
});

const users = client.collection('users');
const snapshot = await users.where('age', '>', 18).get();

const unsubscribe = users
  .where('status', '==', 'active')
  .onSnapshot((snap) => {
    console.log('Active users changed:', snap.size);
  });
```

## Prerequisites

- Node.js 20+
- PostgreSQL 12+ (for generated columns and JSON path support)
- npm 9+ (or pnpm 8+)