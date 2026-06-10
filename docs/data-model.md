# Data Model

## Collection Table Structure

Each PgFire collection maps to a PostgreSQL table with this minimum structure:

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  _created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  _updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Concept Mapping

| Firestore | PostgreSQL |
|---|---|
| Collection | Table |
| Document | Row |
| Document ID | `id` column (TEXT PK) |
| Document fields | `data` JSONB column keys |
| Server timestamp | `_created_at`, `_updated_at` columns |
| Collection group | Table name prefix filtering |

### Document ID

- Auto-generated as UUID v4 when not specified
- User can provide custom IDs (e.g., Firebase-style short IDs or business keys)
- Stored in the `id` TEXT PRIMARY KEY column

## JSONB Data Column

The `data` column stores the entire Firestore document as a JSONB object:

```json
{
  "name": "Alice",
  "age": 30,
  "email": "alice@example.com",
  "tags": ["premium", "beta"],
  "address": {
    "city": "Taipei",
    "country": "Taiwan"
  },
  "metadata": {
    "lastLogin": "2024-01-15T10:30:00Z",
    "loginCount": 42
  }
}
```

## Indexing

### GIN Index (Recommended)

For efficient JSONB querying, create a GIN index:

```sql
CREATE INDEX idx_users_data ON users USING GIN (data jsonb_path_ops);
```

Without this index, JSONB queries will perform sequential scans.

### B-tree Index on Metadata Columns

For frequently filtered columns, add indexed metadata columns:

```sql
ALTER TABLE users ADD COLUMN status TEXT GENERATED ALWAYS AS (data->>'status') STORED;
CREATE INDEX idx_users_status ON users (status);
```

### Full-Text Search

Add a generated tsvector column for full-text search:

```sql
ALTER TABLE users ADD COLUMN _fts TSVECTOR
  GENERATED ALWAYS AS (
    to_tsvector('english',
      COALESCE(data->>'name', '') || ' ' ||
      COALESCE(data->>'email', '') || ' ' ||
      COALESCE(data->>'bio', '')
    )
  ) STORED;

CREATE INDEX idx_users_fts ON users USING GIN (_fts);
```

Query with:

```sql
SELECT id, data FROM users WHERE _fts @@ to_tsquery('english', 'alice & premium');
```

## Migration Example

```sql
-- 001_create_users.sql
CREATE TABLE users (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  _created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  _updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_data ON users USING GIN (data jsonb_path_ops);

-- 002_add_status_column.sql
ALTER TABLE users ADD COLUMN status TEXT
  GENERATED ALWAYS AS (data->>'status') STORED;

CREATE INDEX idx_users_status ON users (status);
```