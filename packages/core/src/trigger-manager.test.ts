import { describe, it, expect, vi } from 'vitest';
import { TriggerManager, NOTIFY_TRIGGER_FUNCTION_SQL } from './trigger-manager.js';
import { NotificationListener, NotificationPayload } from './listen-notify.js';
import { Client } from 'pg';

describe('TriggerManager', () => {
  it('should call setup query with correct SQL', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({}),
    } as any;

    const manager = new TriggerManager(mockClient);
    await manager.setupTriggerFunction();

    expect(mockClient.query).toHaveBeenCalledWith(NOTIFY_TRIGGER_FUNCTION_SQL);
  });

  it('should generate correct SQL to enable trigger for table', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({}),
    } as any;

    const manager = new TriggerManager(mockClient);
    await manager.enableTriggerForTable('users');

    expect(mockClient.query).toHaveBeenCalledTimes(2);
    expect(mockClient.query).toHaveBeenNthCalledWith(1, 'DROP TRIGGER IF EXISTS "pgfire_trg_users" ON "users";');
    expect(mockClient.query).toHaveBeenNthCalledWith(2, expect.stringContaining('CREATE TRIGGER "pgfire_trg_users"'));
  });

  it('should generate correct SQL to disable trigger for table', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({}),
    } as any;

    const manager = new TriggerManager(mockClient);
    await manager.disableTriggerForTable('users');

    expect(mockClient.query).toHaveBeenCalledWith('DROP TRIGGER IF EXISTS "pgfire_trg_users" ON "users";');
  });

  it('should prevent SQL injection in trigger manager', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({}),
    } as any;

    const manager = new TriggerManager(mockClient);
    await expect(manager.enableTriggerForTable('users; DROP TABLE;')).rejects.toThrow(/Invalid table name/);
  });
});

describe('NotificationListener', () => {
  it('should listen and parse notification payloads', async () => {
    // 建立一個 Mock Client，模擬 event emitter 的功能
    const mockClient = new (class extends Client {
      constructor() {
        super();
      }
      query = vi.fn().mockResolvedValue({});
    })();

    const listener = new NotificationListener(mockClient);
    
    const changeCallback = vi.fn();
    const tableCallback = vi.fn();
    
    listener.on('change', changeCallback);
    listener.on('table:users', tableCallback);

    await listener.start();

    expect(mockClient.query).toHaveBeenCalledWith('LISTEN pgfire_changes');

    // 模擬 pg client 收到 notification 事件
    const payload: NotificationPayload = {
      table: 'users',
      id: 'doc-123',
      op: 'INSERT',
      data: { name: 'Alice' },
      old_data: null,
      txid: 100,
      timestamp: new Date().toISOString(),
    };

    mockClient.emit('notification', {
      channel: 'pgfire_changes',
      payload: JSON.stringify(payload),
    });

    expect(changeCallback).toHaveBeenCalledWith(payload);
    expect(tableCallback).toHaveBeenCalledWith(payload);

    await listener.stop();
    expect(mockClient.query).toHaveBeenCalledWith('UNLISTEN pgfire_changes');
  });

  it('should emit error when JSON parsing fails', async () => {
    const mockClient = new (class extends Client {
      constructor() {
        super();
      }
      query = vi.fn().mockResolvedValue({});
    })();

    const listener = new NotificationListener(mockClient);
    const errorCallback = vi.fn();
    listener.on('error', errorCallback);

    await listener.start();

    mockClient.emit('notification', {
      channel: 'pgfire_changes',
      payload: 'invalid-json',
    });

    expect(errorCallback).toHaveBeenCalled();
    expect(errorCallback.mock.calls[0][0].message).toContain('Failed to parse notification payload');
  });
});
