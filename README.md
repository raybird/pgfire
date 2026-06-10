# PgFire

PostgreSQL-based Firestore-like real-time subscription library for TypeScript.

## Architecture

- **@pgfire/core** — Core engine: types, SQL query builder, LISTEN/NOTIFY, trigger manager, serializer
- **@pgfire/client** — Firestore-like client SDK with SSE transport
- **@pgfire/server** — SSE HTTP server with JWT authentication
- **@pgfire/embedded** — Direct database mode for backend-to-backend
- **@pgfire/test-utils** — Test utilities
- **@pgfire/cli** — CLI tools for migration, init, server start

## Status

Project scaffolding in progress.

See [docs/](docs/) for architecture and API documentation.