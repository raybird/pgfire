import { EventEmitter } from 'node:events';
import { Client } from 'pg';

export interface NotificationPayload {
  table: string;
  id: string;
  op: 'INSERT' | 'UPDATE' | 'DELETE';
  data: any | null;
  old_data: any | null;
  txid: number;
  timestamp: string;
}

export declare interface NotificationListener {
  on(event: 'change', listener: (payload: NotificationPayload) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
}

export class NotificationListener extends EventEmitter {
  private isListening = false;

  /**
   * @param client 必須是專屬的 pg.Client 連線（不可在 Pool 中共用）
   */
  constructor(private client: Client) {
    super();
  }

  /**
   * 開始監聽 pgfire_changes 頻道。
   */
  async start(): Promise<void> {
    if (this.isListening) {
      return;
    }

    // 註冊 pg 連線的通知事件回呼
    this.client.on('notification', this.handleNotification);
    this.client.on('error', this.handleClientError);

    await this.client.query('LISTEN pgfire_changes');
    this.isListening = true;
  }

  /**
   * 停止監聽並移除監聽器。
   */
  async stop(): Promise<void> {
    if (!this.isListening) {
      return;
    }

    await this.client.query('UNLISTEN pgfire_changes');
    this.client.off('notification', this.handleNotification);
    this.client.off('error', this.handleClientError);
    this.isListening = false;
  }

  private handleNotification = (msg: any): void => {
    if (msg.channel !== 'pgfire_changes') {
      return;
    }

    try {
      if (!msg.payload) {
        throw new Error('Received empty payload from pg_notify');
      }

      const payload: NotificationPayload = JSON.parse(msg.payload);
      
      // 觸發通用 change 事件
      this.emit('change', payload);

      // 同時觸發特定資料表的變更事件以供更精準的訂閱
      this.emit(`table:${payload.table}`, payload);
    } catch (err) {
      this.emit('error', new Error(`Failed to parse notification payload: ${err instanceof Error ? err.message : String(err)}`));
    }
  };

  private handleClientError = (err: Error): void => {
    this.emit('error', err);
  };
}
