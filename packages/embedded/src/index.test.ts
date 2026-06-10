import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PgFireEmbedded, DocumentSnapshot, QuerySnapshot } from './index.js';
import { increment } from '@pgfire/core';

// Mock pg module
vi.mock('pg', () => {
  const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
  const mockConnect = vi.fn().mockResolvedValue(undefined);
  const mockEnd = vi.fn().mockResolvedValue(undefined);
  const mockOn = vi.fn();
  const mockOff = vi.fn();

  return {
    Pool: vi.fn().mockImplementation(() => ({
      query: mockQuery,
      end: mockEnd,
    })),
    Client: vi.fn().mockImplementation(() => ({
      connect: mockConnect,
      query: mockQuery,
      end: mockEnd,
      on: mockOn,
      off: mockOff,
    })),
  };
});

describe('PgFireEmbedded API', () => {
  let db: PgFireEmbedded;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = new PgFireEmbedded({
      host: 'localhost',
      database: 'test',
    });
    await db.initialize();
  });

  afterEach(async () => {
    await db.close();
  });

  it('should support chainable query syntax', () => {
    const users = db.collection('users');
    const query = users
      .where('age', '>', 18)
      .where('status', '==', 'active')
      .orderBy('age', 'desc')
      .limit(5);

    expect(query.tableName).toBe('users');
  });

  it('should fetch document and return DocumentSnapshot', async () => {
    const mockRow = { id: 'doc-123', data: { name: 'Alice', age: 30 } };
    const poolQueryMock = vi.mocked(db.pool.query);
    poolQueryMock.mockResolvedValueOnce({ rows: [mockRow] } as any);

    const docRef = db.collection('users').doc('doc-123');
    const snap = await docRef.get();

    expect(snap.id).toBe('doc-123');
    expect(snap.exists).toBe(true);
    expect(snap.data()).toEqual({ name: 'Alice', age: 30 });
    expect(snap.get('name')).toBe('Alice');
    expect(poolQueryMock).toHaveBeenCalledWith(
      'SELECT data FROM "users" WHERE id = $1',
      ['doc-123']
    );
  });

  it('should return non-existent DocumentSnapshot when doc not found', async () => {
    const poolQueryMock = vi.mocked(db.pool.query);
    poolQueryMock.mockResolvedValueOnce({ rows: [] } as any);

    const docRef = db.collection('users').doc('non-existent');
    const snap = await docRef.get();

    expect(snap.exists).toBe(false);
    expect(snap.data()).toBeUndefined();
  });

  it('should support set with custom values', async () => {
    const poolQueryMock = vi.mocked(db.pool.query);
    const docRef = db.collection('users').doc('doc-123');
    await docRef.set({ name: 'Bob' });

    expect(poolQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO "users"'),
      ['doc-123', '{"name":"Bob"}']
    );
  });

  it('should support update with increment', async () => {
    const poolQueryMock = vi.mocked(db.pool.query);
    const docRef = db.collection('users').doc('doc-123');
    await docRef.update({ score: increment(10) });

    expect(poolQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE "users" SET data = jsonb_set'),
      ['doc-123', 10]
    );
  });

  it('should calculate Snapshot Diff correctly (docChanges)', () => {
    // 建立 Mock 的 Document Snapshots
    const docA = { id: 'a', data: { val: 1 } };
    const docB = { id: 'b', data: { val: 2 } };
    const docC = { id: 'c', data: { val: 3 } };

    const snap1 = new QuerySnapshot([
      { id: 'a', data: () => ({ val: 1 }), exists: true } as any,
      { id: 'b', data: () => ({ val: 2 }), exists: true } as any,
    ]);

    // 模擬異動：a 修改了，b 被移除，c 被加入
    const snap2 = new QuerySnapshot(
      [
        { id: 'a', data: () => ({ val: 10 }), exists: true } as any,
        { id: 'c', data: () => ({ val: 3 }), exists: true } as any,
      ],
      snap1.docs
    );

    const changes = snap2.docChanges();
    expect(changes.length).toBe(3);

    const added = changes.find(c => c.type === 'added');
    const modified = changes.find(c => c.type === 'modified');
    const removed = changes.find(c => c.type === 'removed');

    expect(added?.doc.id).toBe('c');
    expect(modified?.doc.id).toBe('a');
    expect(removed?.doc.id).toBe('b');
  });

  it('should trigger onSnapshot callbacks when notify occurs', async () => {
    const poolQueryMock = vi.mocked(db.pool.query);
    
    // 第一次 get 傳回第一筆資料
    poolQueryMock.mockResolvedValueOnce({
      rows: [{ id: '1', data: { name: 'Alice' } }]
    } as any);

    const users = db.collection('users');
    const onNextMock = vi.fn();
    
    const unsubscribe = users.onSnapshot(onNextMock);

    // 需給予 async 的 query 執行時間
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(onNextMock).toHaveBeenCalledTimes(1);
    expect(onNextMock.mock.calls[0][0].docs[0].data()).toEqual({ name: 'Alice' });

    // 模擬資料庫發生了異動通知
    poolQueryMock.mockResolvedValueOnce({
      rows: [
        { id: '1', data: { name: 'Alice' } },
        { id: '2', data: { name: 'Bob' } }
      ]
    } as any);

    // 觸發通知事件
    db.listenerEmitter.emit('table:users', {
      table: 'users',
      op: 'INSERT',
      id: '2',
      data: { name: 'Bob' },
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(onNextMock).toHaveBeenCalledTimes(2);
    expect(onNextMock.mock.calls[1][0].docs.length).toBe(2);

    unsubscribe();
  });
});
