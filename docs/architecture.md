# Architecture Overview

## System Overview

PgFire is a real-time data synchronization library built on PostgreSQL's native `LISTEN/NOTIFY` mechanism, providing a Firestore-like API for TypeScript applications.

### Three Operating Modes

1. **Client-Server (SSE)**: Browser/Node.js client communicates via Server-Sent Events over HTTP
2. **Embedded**: Backend code connects directly to PostgreSQL with no HTTP layer
3. **CLI**: Command-line management of migrations, triggers, and server

## Package Architecture

```
                    ┌─────────────────────────┐
                    │     @pgfire/client       │
                    │  (Firestore-like SDK)    │
                    │  - PgFireClient          │
                    │  - CollectionReference    │
                    │  - Query / DocumentRef    │
                    │  - SseTransport          │
                    └───────────┬─────────────┘
                                │ SSE / HTTP
                                ▼
                    ┌─────────────────────────┐
                    │     @pgfire/server       │
                    │  - PgFireServer          │
                    │  - SubscriptionManager   │
                    │  - AuthManager (JWT)      │
                    │  - SSE endpoints         │
                    └───────────┬─────────────┘
                                │
                    ┌───────────┴─────────────┐
                    │                         │
                    ▼                         ▼
          ┌──────────────────┐    ┌──────────────────┐
          │  @pgfire/embedded │    │   @pgfire/core    │
          │  (Direct DB mode) │───▶│  - QueryBuilder   │
          └──────────────────┘    │  - ListenNotify    │
                                  │  - TriggerManager  │
                                  │  - Serializer      │
                                  │  - Types           │
                                  └────────┬───────────┘
                                           │
                                           ▼
                                  ┌──────────────────┐
                                  │   PostgreSQL      │
                                  │  - LISTEN/NOTIFY  │
                                  │  - JSONB columns  │
                                  │  - Trigger funcs  │
                                  └──────────────────┘
```

## Data Flow: Embedded Mode Subscription

```
User Code                  @pgfire/embedded              PostgreSQL
    |                            |                            |
    |-- onSnapshot(callback) --> |                            |
    |                            |-- LISTEN pgfire_changes -->|
    |                            |-- SELECT * FROM users ---->|
    |                            |    WHERE ...               |
    |                            |<--- result rows ---------- |
    |<-- callback(snapshot1) --- |                            |
    |                            |                            |
    |                            |    [INSERT INTO users...]  |
    |                            |<--- NOTIFY payload --------|
    |                            |                            |
    |                            |-- SELECT * FROM users ---->|
    |                            |    WHERE ... (re-execute)  |
    |                            |<--- result rows ---------- |
    |                            |-- diff snapshots -->       |
    |<-- callback(snapshot2) --- |                            |
```

## Data Flow: Client-Server Mode Subscription

```
Browser Client           @pgfire/server              PostgreSQL
    |                         |                          |
    |-- GET /pgfire/sse ----> |                          |
    |<-- event: connected ----|                          |
    |-- POST /subscribe ----->|                          |
    |                         |-- LISTEN pgfire_changes->|
    |<-- 200 { subId } -------|                          |
    |                         |                          |
    |                         |  [INSERT INTO users...]  |
    |                         |<-- NOTIFY payload -------|
    |                         |-- filter match? ----->   |
    |<-- event: change -------|                          |
    |   {payload}             |                          |
```

## Security

- **SQL injection prevention**: All values are parameterized ($1, $2, ...). Field names in JSONB paths are validated against `/^[a-zA-Z_][a-zA-Z0-9_.]*$/`.
- **JWT authentication**: All SSE and HTTP endpoints are protected by JWT middleware. Tokens can be scoped to specific tables and permissions.
- **Table name validation**: Since PostgreSQL does not allow parameterized identifiers, table names are validated strictly and escaped.
- **NOTIFY payload**: Kept under 8000 bytes. Larger documents must store references and use out-of-band storage.

## Performance Considerations

1. **GIN indexes**: `CREATE INDEX ON tablename USING GIN (data jsonb_path_ops)` is strongly recommended
2. **Computed columns**: Frequently queried fields can use PostgreSQL generated columns to avoid JSONB extraction overhead
3. **LISTEN connection pool**: Uses a dedicated non-pooled connection for LISTEN/NOTIFY; a separate pool for queries
4. **Full-query re-execution**: Embedded mode re-executes the full query on each change. Mitigated by indexed/computed columns and LIMIT clauses