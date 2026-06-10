import { describe, it, expect } from 'vitest';
import { compileUpdate, compileSet } from './update-builder.js';
import { increment, arrayUnion, arrayRemove, serverTimestamp, deleteField } from './types.js';

describe('UpdateBuilder', () => {
  it('should compile basic update', () => {
    const compiled = compileUpdate('users', 'doc-123', { name: 'Alice', age: 30 });
    
    expect(compiled.text).toBe(
      `UPDATE "users" SET data = jsonb_set(jsonb_set(data, '{age}', $2::jsonb), '{name}', $3::jsonb), _updated_at = now() WHERE id = $1`
    );
    expect(compiled.values).toEqual(['doc-123', '30', '"Alice"']);
  });

  it('should compile nested update paths', () => {
    const compiled = compileUpdate('users', 'doc-123', { 'profile.address.city': 'Taipei' });

    expect(compiled.text).toBe(
      `UPDATE "users" SET data = jsonb_set(data, '{profile,address,city}', $2::jsonb), _updated_at = now() WHERE id = $1`
    );
    expect(compiled.values).toEqual(['doc-123', '"Taipei"']);
  });

  it('should compile deleteField sentinel', () => {
    const compiled = compileUpdate('users', 'doc-123', {
      status: deleteField(),
      'profile.age': deleteField(),
    });

    expect(compiled.text).toBe(
      `UPDATE "users" SET data = ((data #- '{profile,age}') #- '{status}'), _updated_at = now() WHERE id = $1`
    );
    expect(compiled.values).toEqual(['doc-123']);
  });

  it('should compile increment sentinel', () => {
    const compiled = compileUpdate('users', 'doc-123', { score: increment(5) });

    expect(compiled.text).toBe(
      `UPDATE "users" SET data = jsonb_set(data, '{score}', to_jsonb(COALESCE((data #>> '{score}')::numeric, 0) + $2::numeric)), _updated_at = now() WHERE id = $1`
    );
    expect(compiled.values).toEqual(['doc-123', 5]);
  });

  it('should compile arrayUnion sentinel', () => {
    const compiled = compileUpdate('users', 'doc-123', { tags: arrayUnion('a', 'b') });

    expect(compiled.text).toBe(
      `UPDATE "users" SET data = jsonb_set(data, '{tags}', COALESCE(data #> '{tags}', '[]'::jsonb) || $2::jsonb), _updated_at = now() WHERE id = $1`
    );
    expect(compiled.values).toEqual(['doc-123', '["a","b"]']);
  });

  it('should compile arrayRemove sentinel', () => {
    const compiled = compileUpdate('users', 'doc-123', { tags: arrayRemove('a', 'b') });

    expect(compiled.text).toContain('SELECT COALESCE(jsonb_agg(elem), \'[]\'::jsonb)');
    expect(compiled.text).toContain('WHERE NOT (elem::text = ANY($2::text[]))');
    expect(compiled.values).toEqual(['doc-123', ['"a"', '"b"']]);
  });

  it('should compile serverTimestamp sentinel', () => {
    const compiled = compileUpdate('users', 'doc-123', { updatedAt: serverTimestamp() });

    expect(compiled.text).toBe(
      `UPDATE "users" SET data = jsonb_set(data, '{updatedAt}', to_jsonb($2::text)), _updated_at = now() WHERE id = $1`
    );
    expect(new Date(compiled.values[1]).getTime()).not.toBeNaN();
  });

  it('should compile set overwrite without merge', () => {
    const compiled = compileSet('users', 'doc-123', { name: 'Alice' });

    expect(compiled.text).toBe(
      `INSERT INTO "users" (id, data, _created_at, _updated_at) VALUES ($1, $2::jsonb, now(), now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, _updated_at = now()`
    );
    expect(compiled.values).toEqual(['doc-123', '{"name":"Alice"}']);
  });

  it('should compile set with merge', () => {
    const compiled = compileSet('users', 'doc-123', { name: 'Alice', age: increment(1) }, { merge: true });

    expect(compiled.text).toContain('INSERT INTO "users" (id, data, _created_at, _updated_at) VALUES ($1, $2::jsonb, now(), now()) ON CONFLICT (id) DO UPDATE SET data =');
    expect(compiled.text).toContain('COALESCE((data #>> \'{age}\')::numeric, 0)');
    expect(compiled.values[0]).toBe('doc-123');
    expect(JSON.parse(compiled.values[1])).toEqual({ name: 'Alice', age: 1 });
  });
});
