import { Pool } from 'pg';
import { QueryRequest, compileQuery, NotificationPayload } from '@pgfire/core';

export interface Subscription {
  id: string;
  clientId: string;
  table: string;
  query: QueryRequest;
  activeDocIds: Set<string>;
}

export class SubscriptionManager {
  // Map<subscriptionId, Subscription>
  private subscriptions = new Map<string, Subscription>();
  
  // Map<clientId, Set<subscriptionId>>
  private clientSubscriptions = new Map<string, Set<string>>();

  constructor(private pool: Pool) {}

  /**
   * 註冊一個新訂閱，並執行 initial query 載入目前符合的文檔 ID，
   * 回傳初始的 docs 資料。
   */
  async addSubscription(
    clientId: string,
    table: string,
    query: QueryRequest
  ): Promise<{ subscriptionId: string; initialDocs: any[] }> {
    const subscriptionId = `sub_${Math.random().toString(36).substring(2, 11)}`;

    // 執行初始查詢以初始化 activeDocIds
    const compiled = compileQuery(query);
    const result = await this.pool.query(compiled.text, compiled.values);
    
    const activeDocIds = new Set<string>();
    const initialDocs = result.rows.map((row: any) => {
      activeDocIds.add(row.id);
      return { id: row.id, data: row.data };
    });

    const sub: Subscription = {
      id: subscriptionId,
      clientId,
      table,
      query,
      activeDocIds,
    };

    this.subscriptions.set(subscriptionId, sub);

    if (!this.clientSubscriptions.has(clientId)) {
      this.clientSubscriptions.set(clientId, new Set());
    }
    this.clientSubscriptions.get(clientId)!.add(subscriptionId);

    return { subscriptionId, initialDocs };
  }

  /**
   * 取消特定訂閱
   */
  removeSubscription(subscriptionId: string): void {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) return;

    this.subscriptions.delete(subscriptionId);
    const clientSubs = this.clientSubscriptions.get(sub.clientId);
    if (clientSubs) {
      clientSubs.delete(subscriptionId);
      if (clientSubs.size === 0) {
        this.clientSubscriptions.delete(sub.clientId);
      }
    }
  }

  /**
   * 清除特定 Client 的所有訂閱（例如斷線時）
   */
  removeClient(clientId: string): string[] {
    const clientSubs = this.clientSubscriptions.get(clientId);
    if (!clientSubs) return [];

    const removedIds: string[] = [];
    for (const subId of clientSubs) {
      this.subscriptions.delete(subId);
      removedIds.push(subId);
    }
    this.clientSubscriptions.delete(clientId);
    return removedIds;
  }

  /**
   * 取得特定 Table 的所有活躍訂閱列表
   */
  getSubscriptionsForTable(tableName: string): Subscription[] {
    const list: Subscription[] = [];
    for (const sub of this.subscriptions.values()) {
      if (sub.table === tableName) {
        list.push(sub);
      }
    }
    return list;
  }

  /**
   * 當資料庫變更通知到達時，處理過濾與分發。
   * 會回傳需要傳送給客戶端的異動事件陣列。
   */
  async handleDbNotification(
    payload: NotificationPayload
  ): Promise<{ clientId: string; event: string; data: any }[]> {
    const matchedSubs = this.getSubscriptionsForTable(payload.table);
    if (matchedSubs.length === 0) return [];

    const events: { clientId: string; event: string; data: any }[] = [];

    for (const sub of matchedSubs) {
      const { id: subId, clientId, query, activeDocIds } = sub;

      if (payload.op === 'DELETE') {
        if (activeDocIds.has(payload.id)) {
          activeDocIds.delete(payload.id);
          events.push({
            clientId,
            event: 'change',
            data: {
              subscriptionId: subId,
              changes: [
                {
                  type: 'removed',
                  doc: { id: payload.id, data: null },
                },
              ],
            },
          });
        }
      } else {
        // INSERT 或是 UPDATE 的情況，執行資料庫 recheck
        // 我們將原本 query 的 wheres 加上 id 的限制條件
        const recheckQuery: QueryRequest = {
          ...query,
          wheres: [
            ...query.wheres,
            { field: 'id', op: '==', value: payload.id },
          ],
          limit: 1, // 只查這筆
        };

        const compiled = compileQuery(recheckQuery);
        const result = await this.pool.query(compiled.text, compiled.values);
        
        const isMatch = result.rows.length > 0;

        if (isMatch) {
          const docData = result.rows[0].data;
          const hadDoc = activeDocIds.has(payload.id);
          
          activeDocIds.add(payload.id);
          
          events.push({
            clientId,
            event: 'change',
            data: {
              subscriptionId: subId,
              changes: [
                {
                  type: hadDoc ? 'modified' : 'added',
                  doc: { id: payload.id, data: docData },
                },
              ],
            },
          });
        } else {
          // 不符合查詢條件，但如果原本有，則說明它被移出了（例如更新後條件不符）
          if (activeDocIds.has(payload.id)) {
            activeDocIds.delete(payload.id);
            events.push({
              clientId,
              event: 'change',
              data: {
                subscriptionId: subId,
                changes: [
                  {
                    type: 'removed',
                    doc: { id: payload.id, data: null },
                  },
                ],
              },
            });
          }
        }
      }
    }

    return events;
  }
}
