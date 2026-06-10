import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthManager } from './auth.js';
import { SubscriptionManager } from './subscription.js';
import { PgFireServer } from './server.js';
import { QueryRequest, NotificationPayload } from '@pgfire/core';

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

describe('AuthManager', () => {
  const secret = 'test-secret';
  const auth = new AuthManager(secret, '1h');

  it('should sign and verify token correctly', () => {
    const payload = { sub: 'user-1', tables: ['users'], permissions: 'read' as const };
    const token = auth.generateToken(payload);
    const verified = auth.verifyToken(token);

    expect(verified.sub).toBe('user-1');
    expect(verified.tables).toEqual(['users']);
    expect(verified.permissions).toBe('read');
  });

  it('should validate access permissions correctly', () => {
    const payload = { sub: 'user-1', tables: ['users'], permissions: 'read' as const };

    expect(auth.canAccess(payload, 'users', 'read')).toBe(true);
    expect(auth.canAccess(payload, 'users', 'write')).toBe(false);
    expect(auth.canAccess(payload, 'posts', 'read')).toBe(false);
  });
});

describe('SubscriptionManager', () => {
  let subMgr: SubscriptionManager;
  let mockPool: any;

  beforeEach(() => {
    mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };
    subMgr = new SubscriptionManager(mockPool);
  });

  it('should add and remove subscription', async () => {
    const query: QueryRequest = {
      table: 'users',
      wheres: [],
      orderBys: [],
    };

    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: '1', data: { name: 'Alice' } },
        { id: '2', data: { name: 'Bob' } },
      ],
    });

    const { subscriptionId, initialDocs } = await subMgr.addSubscription(
      'client-1',
      'users',
      query
    );

    expect(subscriptionId).toBeDefined();
    expect(initialDocs.length).toBe(2);
    expect(subMgr.getSubscriptionsForTable('users').length).toBe(1);

    subMgr.removeSubscription(subscriptionId);
    expect(subMgr.getSubscriptionsForTable('users').length).toBe(0);
  });

  it('should filter and route notifications correctly (added, modified, removed)', async () => {
    const query: QueryRequest = {
      table: 'users',
      wheres: [{ field: 'age', op: '>', value: 18 }],
      orderBys: [],
    };

    // 初始查詢無結果
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const { subscriptionId } = await subMgr.addSubscription('client-1', 'users', query);

    // 1. 模擬資料庫 INSERT 一筆 age = 20 的資料（recheck 符合）
    const notifyPayloadInsert: NotificationPayload = {
      table: 'users',
      id: 'doc-1',
      op: 'INSERT',
      data: { name: 'Alice', age: 20 },
      old_data: null,
      txid: 100,
      timestamp: new Date().toISOString(),
    };

    // recheck 符合，返回該筆資料
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'doc-1', data: { name: 'Alice', age: 20 } }],
    });

    const events1 = await subMgr.handleDbNotification(notifyPayloadInsert);
    expect(events1.length).toBe(1);
    expect(events1[0].data.changes[0].type).toBe('added');
    expect(events1[0].data.changes[0].doc.data.age).toBe(20);

    // 2. 模擬資料庫 UPDATE 該筆資料 age = 21（recheck 符合且原本就有該 ID）
    const notifyPayloadUpdate: NotificationPayload = {
      table: 'users',
      id: 'doc-1',
      op: 'UPDATE',
      data: { name: 'Alice', age: 21 },
      old_data: { name: 'Alice', age: 20 },
      txid: 101,
      timestamp: new Date().toISOString(),
    };

    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'doc-1', data: { name: 'Alice', age: 21 } }],
    });

    const events2 = await subMgr.handleDbNotification(notifyPayloadUpdate);
    expect(events2.length).toBe(1);
    expect(events2[0].data.changes[0].type).toBe('modified');
    expect(events2[0].data.changes[0].doc.data.age).toBe(21);

    // 3. 模擬資料庫 UPDATE 該筆資料 age = 15（recheck 不符合且原本有該 ID -> 觸發 removed）
    const notifyPayloadUpdateOut: NotificationPayload = {
      table: 'users',
      id: 'doc-1',
      op: 'UPDATE',
      data: { name: 'Alice', age: 15 },
      old_data: { name: 'Alice', age: 21 },
      txid: 102,
      timestamp: new Date().toISOString(),
    };

    mockPool.query.mockResolvedValueOnce({ rows: [] }); // 不符合了

    const events3 = await subMgr.handleDbNotification(notifyPayloadUpdateOut);
    expect(events3.length).toBe(1);
    expect(events3[0].data.changes[0].type).toBe('removed');

    // 4. 模擬資料庫 DELETE 已經不在結果集中的該筆資料（不應該觸發任何事件）
    const notifyPayloadDelete: NotificationPayload = {
      table: 'users',
      id: 'doc-1',
      op: 'DELETE',
      data: null,
      old_data: { name: 'Alice', age: 15 },
      txid: 103,
      timestamp: new Date().toISOString(),
    };

    const events4 = await subMgr.handleDbNotification(notifyPayloadDelete);
    expect(events4.length).toBe(0); // 因為之前已被移除出 activeDocIds
  });
});
