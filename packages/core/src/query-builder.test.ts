import { describe, it, expect } from 'vitest';
import { compileQuery } from './query-builder.js';
import { QueryRequest } from './types.js';

describe('QueryBuilder', () => {
  it('should compile a basic equal query', () => {
    const query: QueryRequest = {
      table: 'users',
      wheres: [{ field: 'status', op: '==', value: 'active' }],
      orderBys: [],
    };

    const compiled = compileQuery(query);
    expect(compiled.text).toBe(
      `SELECT id, data, _created_at, _updated_at FROM "users" WHERE data #>> '{status}' = $1`
    );
    expect(compiled.values).toEqual(['active']);
  });

  it('should compile nested field paths correctly', () => {
    const query: QueryRequest = {
      table: 'users',
      wheres: [{ field: 'profile.address.city', op: '==', value: 'Taipei' }],
      orderBys: [],
    };

    const compiled = compileQuery(query);
    expect(compiled.text).toBe(
      `SELECT id, data, _created_at, _updated_at FROM "users" WHERE data #>> '{profile,address,city}' = $1`
    );
    expect(compiled.values).toEqual(['Taipei']);
  });

  it('should handle numeric comparison operators and cast to numeric', () => {
    const query: QueryRequest = {
      table: 'users',
      wheres: [{ field: 'age', op: '>', value: 18 }],
      orderBys: [],
    };

    const compiled = compileQuery(query);
    expect(compiled.text).toBe(
      `SELECT id, data, _created_at, _updated_at FROM "users" WHERE (data #>> '{age}')::numeric > $1`
    );
    expect(compiled.values).toEqual([18]);
  });

  it('should combine multiple where conditions with AND', () => {
    const query: QueryRequest = {
      table: 'users',
      wheres: [
        { field: 'status', op: '==', value: 'active' },
        { field: 'age', op: '>=', value: 18 },
      ],
      orderBys: [],
    };

    const compiled = compileQuery(query);
    expect(compiled.text).toBe(
      `SELECT id, data, _created_at, _updated_at FROM "users" WHERE data #>> '{status}' = $1 AND (data #>> '{age}')::numeric >= $2`
    );
    expect(compiled.values).toEqual(['active', 18]);
  });

  it('should compile IN and NOT-IN operators', () => {
    const queryIn: QueryRequest = {
      table: 'users',
      wheres: [{ field: 'role', op: 'in', value: ['admin', 'editor'] }],
      orderBys: [],
    };
    const compiledIn = compileQuery(queryIn);
    expect(compiledIn.text).toBe(
      `SELECT id, data, _created_at, _updated_at FROM "users" WHERE data #>> '{role}' = ANY($1::text[])`
    );
    expect(compiledIn.values).toEqual([['admin', 'editor']]);

    const queryNotIn: QueryRequest = {
      table: 'users',
      wheres: [{ field: 'role', op: 'not-in', value: ['guest'] }],
      orderBys: [],
    };
    const compiledNotIn = compileQuery(queryNotIn);
    expect(compiledNotIn.text).toBe(
      `SELECT id, data, _created_at, _updated_at FROM "users" WHERE data #>> '{role}' != ALL($1::text[])`
    );
    expect(compiledNotIn.values).toEqual([['guest']]);
  });

  it('should compile array-contains and array-contains-any', () => {
    const queryContains: QueryRequest = {
      table: 'users',
      wheres: [{ field: 'tags', op: 'array-contains', value: 'premium' }],
      orderBys: [],
    };
    const compiledContains = compileQuery(queryContains);
    expect(compiledContains.text).toBe(
      `SELECT id, data, _created_at, _updated_at FROM "users" WHERE data #> '{tags}' @> $1::jsonb`
    );
    expect(compiledContains.values).toEqual(['"premium"']);

    const queryContainsAny: QueryRequest = {
      table: 'users',
      wheres: [{ field: 'tags', op: 'array-contains-any', value: ['a', 'b'] }],
      orderBys: [],
    };
    const compiledContainsAny = compileQuery(queryContainsAny);
    expect(compiledContainsAny.text).toBe(
      `SELECT id, data, _created_at, _updated_at FROM "users" WHERE data #> '{tags}' ?| $1::text[]`
    );
    expect(compiledContainsAny.values).toEqual([['a', 'b']]);
  });

  it('should handle orderBy with direction and apply numeric cast if in numeric where', () => {
    const query: QueryRequest = {
      table: 'users',
      wheres: [{ field: 'age', op: '>', value: 18 }],
      orderBys: [
        { field: 'age', direction: 'desc' },
        { field: 'name', direction: 'asc' },
      ],
    };

    const compiled = compileQuery(query);
    expect(compiled.text).toBe(
      `SELECT id, data, _created_at, _updated_at FROM "users" WHERE (data #>> '{age}')::numeric > $1 ORDER BY (data #>> '{age}')::numeric DESC, data #>> '{name}' ASC`
    );
    expect(compiled.values).toEqual([18]);
  });

  it('should handle limit', () => {
    const query: QueryRequest = {
      table: 'users',
      wheres: [],
      orderBys: [],
      limit: 10,
    };

    const compiled = compileQuery(query);
    expect(compiled.text).toBe(
      `SELECT id, data, _created_at, _updated_at FROM "users" LIMIT $1`
    );
    expect(compiled.values).toEqual([10]);
  });

  it('should prevent SQL injection in table name', () => {
    const query: QueryRequest = {
      table: 'users; DROP TABLE users;',
      wheres: [],
      orderBys: [],
    };

    expect(() => compileQuery(query)).toThrow(/Invalid table name/);
  });

  it('should prevent SQL injection in field paths', () => {
    const query: QueryRequest = {
      table: 'users',
      wheres: [{ field: "name'; DROP TABLE users;--", op: '==', value: 'Alice' }],
      orderBys: [],
    };

    expect(() => compileQuery(query)).toThrow(/Invalid field path/);
  });
});
