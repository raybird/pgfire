# Server Setup Guide

## Standalone Server

```typescript
import { PgFireServer } from '@pgfire/server';

const server = new PgFireServer({
  port: 3000,
  host: '0.0.0.0',
  db: {
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT) || 5432,
    database: process.env.PGDATABASE || 'mydb',
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
  },
  auth: {
    secret: process.env.JWT_SECRET || 'change-me',
    tokenExpiry: '24h',
    required: true,
  },
  cors: {
    origin: ['http://localhost:5173', 'https://myapp.com'],
  },
});

await server.start();
console.log('PgFire server running');
```

## Attach to Existing Server

```typescript
import http from 'node:http';
import { PgFireServer } from '@pgfire/server';

const httpServer = http.createServer((req, res) => {
  // Your existing routes
});

const pgfire = new PgFireServer({ /* config */ });
pgfire.attachToServer(httpServer);

httpServer.listen(3000);
```

## JWT Authentication

### Generate Tokens

```typescript
import { AuthManager } from '@pgfire/server';

const auth = new AuthManager('my-secret', '1h');

// Simple client token
const token = auth.generateToken({ sub: 'user-1' });

// Scoped token
const scopedToken = auth.generateToken({
  sub: 'user-1',
  tables: ['users', 'posts'],
  permissions: 'readwrite',
});
```

### CLI

```bash
npx pgfire auth token --secret my-secret --sub user-1
npx pgfire auth token --secret my-secret --sub user-1 --tables users,posts --permissions read
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PGHOST` | localhost | PostgreSQL host |
| `PGPORT` | 5432 | PostgreSQL port |
| `PGDATABASE` | mydb | Database name |
| `PGUSER` | postgres | Database user |
| `PGPASSWORD` | - | Database password |
| `JWT_SECRET` | - | JWT signing secret |
| `JWT_EXPIRY` | 24h | Token expiration |
| `PORT` | 3000 | Server port |
| `HOST` | 0.0.0.0 | Server host |
| `CORS_ORIGIN` | * | Allowed origins |

## Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
RUN npm install -g @pgfire/server
EXPOSE 3000
CMD ["npx", "pgfire", "server", "start"]
```

```yaml
# docker-compose.yml
services:
  pgfire:
    image: node:20-alpine
    command: npx pgfire server start
    environment:
      PGHOST: postgres
      PGDATABASE: pgfire
      PGUSER: pgfire
      PGPASSWORD: secret
      JWT_SECRET: change-me-in-production
      PORT: '3000'
    ports:
      - '3000:3000'
    depends_on:
      - postgres

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: pgfire
      POSTGRES_USER: pgfire
      POSTGRES_PASSWORD: secret
```

## Scaling

- The SSE server is stateful (in-memory subscriptions). For horizontal scaling:
  - Use a shared NOTIFY connection per server instance (each instance independently listens to PostgreSQL)
  - Or use Redis pub/sub to broadcast notifications across instances
- PostgreSQL LISTEN/NOTIFY is per-connection; each server instance maintains its own LISTEN connection