# Querying Guide

## Firestore to PostgreSQL Operator Mapping

| Firestore Query | PostgreSQL Generated SQL |
|---|---|
| `.where('status', '==', 'active')` | `data->>'status' = $1` |
| `.where('status', '!=', 'deleted')` | `data->>'status' != $1` |
| `.where('age', '<', 65)` | `(data->>'age')::numeric < $1` |
| `.where('age', '<=', 64)` | `(data->>'age')::numeric <= $1` |
| `.where('age', '>', 18)` | `(data->>'age')::numeric > $1` |
| `.where('age', '>=', 18)` | `(data->>'age')::numeric >= $1` |
| `.where('status', 'in', ['a', 'b'])` | `data->>'status' = ANY($1::text[])` |
| `.where('status', 'not-in', ['x'])` | `data->>'status' != ALL($1::text[])` |
| `.where('tags', 'array-contains', 'x')` | `data->'tags' @> $1::jsonb` |
| `.where('tags', 'array-contains-any', ['a', 'b'])` | `data->'tags' ?| $1::text[]` |

## Nested Field Paths

For nested objects, use dot notation:

```typescript
// JavaScript
users.where('address.city', '==', 'Taipei');

// Generated SQL
WHERE data #>> '{address,city}' = $1
```

The `#>>` operator extracts JSONB sub-paths at the specified path, correctly handling nested objects.

## Compound Queries

Multiple `where` clauses are combined with AND:

```typescript
users
  .where('age', '>', 18)
  .where('status', '==', 'active')
  .where('tags', 'array-contains', 'premium')
  .orderBy('age', 'desc')
  .limit(10);

// Generated SQL
SELECT id, data, _created_at, _updated_at
FROM users
WHERE (data->>'age')::numeric > $1
  AND data->>'status' = $2
  AND data->'tags' @> $3::jsonb
ORDER BY (data->>'age')::numeric DESC
LIMIT $4;
```

## Query Limitations

- **No OR conditions**: Multiple `where` clauses are always AND. For OR logic, run multiple queries and merge results client-side.
- **No NOT operator**: Use `!=` and `not-in` for exclusion.
- **No array-contains on non-array fields**: The value must be a JSON array in the document.
- **Sort order**: `orderBy` follows the field cast rules (numeric for comparison operators, text otherwise).

## Performance Tips

1. Always create a GIN index on the `data` column
2. For frequently filtered fields, add a PostgreSQL generated column with a B-tree index
3. Use `limit()` to cap result sizes
4. Avoid `!=` and `not-in` on large collections (they can be slow without proper indexing)