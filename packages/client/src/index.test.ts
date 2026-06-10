import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgFireClient, QuerySnapshot, increment } from './index.js';

// Mock fetch globally
const mockFetch = vi.fn();
globalThis.fetch = mockFetch as any;

// Mock EventSource globally for testing
class MockEventSource {
  public listeners: Record<string, Function[]> = {};
  constructor(public url: string) {
    setTimeout(() => {
      // 模擬連接成功，觸發 connected 事件
      this.trigger('connected', {
        data: JSON.stringify({ clientId: 'mock-client-123' }),
      });
    }, 10);
  }
  addEventListener(event: string, callback: Function) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(callback);
  }
  trigger(event: string, data: any) {
    if (this.listeners[event]) {
      this.listeners[event].forEach(cb => cb(data));
    }
  }
  close() {}
  onerror() {}
}

(globalThis as any).EventSource = MockEventSource;

describe('PgFireClient CRUD requests', () => {
  let client: PgFireClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new PgFireClient({
      server: {
        url: 'http://localhost:3000',
        token: 'my-jwt-token',
      },
    });
  });

  it('should send correct POST request on get()', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ docs: [{ id: '1', data: { name: 'Alice' } }] }),
    });

    const snap = await client.collection('users').where('age', '>', 18).get();

    expect(snap.size).toBe(1);
    expect(snap.docs[0].id).toBe('1');
    expect(snap.docs[0].data()).toEqual({ name: 'Alice' });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/pgfire/get',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          table: 'users',
          query: {
            wheres: [{ field: 'age', op: '>', value: 18 }],
            orderBys: [],
          },
        }),
      })
    );
  });

  it('should serialize FieldValue correctly on update()', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    const docRef = client.collection('users').doc('user-1');
    await docRef.update({ score: increment(5) });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/pgfire/update',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          table: 'users',
          id: 'user-1',
          data: {
            score: {
              __pgfire_sentinel__: 'increment',
              operand: 5,
            },
          },
        }),
      })
    );
  });

  it('should process onSnapshot SSE notifications and update client-side cache', async () => {
    // 模擬 subscribe 的 HTTP 請求
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ subscriptionId: 'sub-999' }),
    });

    const users = client.collection('users').orderBy('score', 'desc').limit(2);
    const onNextMock = vi.fn();

    const unsubscribe = users.onSnapshot(onNextMock);

    // 等待 EventSource 連線與 subscribe 完成
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/pgfire/subscribe',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"clientId"'), // 因為此時已經取得 clientId
      })
    );

    // 取得當前模擬的 EventSource 實例並觸發事件
    const esInstance = (client as any).eventSource as MockEventSource;
    expect(esInstance).toBeDefined();

    // 1. 模擬推送 added
    esInstance.trigger('change', {
      data: JSON.stringify({
        subscriptionId: 'sub-999',
        changes: [
          { type: 'added', doc: { id: 'doc-1', data: { score: 10 } } },
          { type: 'added', doc: { id: 'doc-2', data: { score: 20 } } },
        ],
      }),
    });

    expect(onNextMock).toHaveBeenCalledTimes(1);
    const snap1 = onNextMock.mock.calls[0][0] as QuerySnapshot;
    expect(snap1.size).toBe(2);
    // 檢查是否有排序 (desc: doc-2 score 20 先，doc-1 score 10 後)
    expect(snap1.docs[0].id).toBe('doc-2');

    // 2. 模擬推送 modified (將 doc-1 score 修改為 30)
    esInstance.trigger('change', {
      data: JSON.stringify({
        subscriptionId: 'sub-999',
        changes: [
          { type: 'modified', doc: { id: 'doc-1', data: { score: 30 } } },
        ],
      }),
    });

    expect(onNextMock).toHaveBeenCalledTimes(2);
    const snap2 = onNextMock.mock.calls[1][0] as QuerySnapshot;
    // 排序應該被更新 (doc-1 score 30 先，doc-2 score 20 後)
    expect(snap2.docs[0].id).toBe('doc-1');

    // 3. 模擬推送 removed (移除 doc-1)
    esInstance.trigger('change', {
      data: JSON.stringify({
        subscriptionId: 'sub-999',
        changes: [
          { type: 'removed', doc: { id: 'doc-1', data: null } },
        ],
      }),
    });

    expect(onNextMock).toHaveBeenCalledTimes(3);
    const snap3 = onNextMock.mock.calls[2][0] as QuerySnapshot;
    expect(snap3.size).toBe(1);
    expect(snap3.docs[0].id).toBe('doc-2');

    unsubscribe();
  });
});
