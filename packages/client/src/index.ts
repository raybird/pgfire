import { 
  DocumentData, 
  WhereCondition, 
  OrderByCondition, 
  WhereFilterOp, 
  OrderByDirection, 
  FieldValue,
  reviveFieldValues
} from '@pgfire/core';

// 重新導出 FieldValue 哨兵以供客戶端使用
export { increment, arrayUnion, arrayRemove, serverTimestamp, deleteField, FieldValue } from '@pgfire/core';

export class DocumentSnapshot<T = DocumentData> {
  constructor(
    public readonly id: string,
    private readonly _data: T | undefined,
    public readonly exists: boolean
  ) {}

  data(): T | undefined {
    return this._data;
  }

  get(field: string): any {
    if (!this._data) return undefined;
    const parts = field.split('.');
    let current: any = this._data;
    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      current = current[part];
    }
    return current;
  }
}

export class QueryDocumentSnapshot<T = DocumentData> extends DocumentSnapshot<T> {
  constructor(id: string, data: T) {
    super(id, data, true);
  }

  override data(): T {
    return super.data() as T;
  }
}

export interface DocumentChange<T = DocumentData> {
  readonly type: 'added' | 'modified' | 'removed';
  readonly doc: QueryDocumentSnapshot<T>;
  readonly oldIndex: number;
  readonly newIndex: number;
}

export class QuerySnapshot<T = DocumentData> {
  public readonly docs: QueryDocumentSnapshot<T>[];
  public readonly size: number;
  public readonly empty: boolean;
  private readonly _changes: DocumentChange<T>[];

  constructor(docs: QueryDocumentSnapshot<T>[], oldDocs?: QueryDocumentSnapshot<T>[]) {
    this.docs = docs;
    this.size = docs.length;
    this.empty = docs.length === 0;
    this._changes = this.computeChanges(docs, oldDocs || []);
  }

  forEach(callback: (doc: QueryDocumentSnapshot<T>) => void): void {
    this.docs.forEach(callback);
  }

  docChanges(): DocumentChange<T>[] {
    return this._changes;
  }

  private computeChanges(
    newDocs: QueryDocumentSnapshot<T>[],
    oldDocs: QueryDocumentSnapshot<T>[]
  ): DocumentChange<T>[] {
    const changes: DocumentChange<T>[] = [];
    const oldMap = new Map<string, { doc: QueryDocumentSnapshot<T>; index: number }>();
    oldDocs.forEach((doc, index) => oldMap.set(doc.id, { doc, index }));

    const newMap = new Map<string, { doc: QueryDocumentSnapshot<T>; index: number }>();
    newDocs.forEach((doc, index) => newMap.set(doc.id, { doc, index }));

    newDocs.forEach((newDoc, newIndex) => {
      const oldItem = oldMap.get(newDoc.id);
      if (!oldItem) {
        changes.push({
          type: 'added',
          doc: newDoc,
          oldIndex: -1,
          newIndex,
        });
      } else {
        const hasChanged = JSON.stringify(newDoc.data()) !== JSON.stringify(oldItem.doc.data());
        if (hasChanged) {
          changes.push({
            type: 'modified',
            doc: newDoc,
            oldIndex: oldItem.index,
            newIndex,
          });
        }
      }
    });

    oldDocs.forEach((oldDoc, oldIndex) => {
      if (!newMap.has(oldDoc.id)) {
        changes.push({
          type: 'removed',
          doc: oldDoc,
          oldIndex,
          newIndex: -1,
        });
      }
    });

    return changes;
  }
}

export class Query<T = DocumentData> {
  constructor(
    protected readonly client: PgFireClient,
    public readonly tableName: string,
    protected readonly wheres: WhereCondition[] = [],
    protected readonly orderBys: OrderByCondition[] = [],
    protected readonly limitVal?: number
  ) {}

  where(field: string, op: WhereFilterOp, value: any): Query<T> {
    return new Query<T>(
      this.client,
      this.tableName,
      [...this.wheres, { field, op, value }],
      this.orderBys,
      this.limitVal
    );
  }

  orderBy(field: string, direction: OrderByDirection = 'asc'): Query<T> {
    return new Query<T>(
      this.client,
      this.tableName,
      this.wheres,
      [...this.orderBys, { field, direction }],
      this.limitVal
    );
  }

  limit(n: number): Query<T> {
    return new Query<T>(this.client, this.tableName, this.wheres, this.orderBys, n);
  }

  async get(): Promise<QuerySnapshot<T>> {
    const res = await this.client.request('/pgfire/get', {
      table: this.tableName,
      query: {
        wheres: this.wheres,
        orderBys: this.orderBys,
        limit: this.limitVal,
      },
    });

    const docs = res.docs.map(
      (doc: any) => new QueryDocumentSnapshot<T>(doc.id, doc.data as T)
    );

    return new QuerySnapshot<T>(docs);
  }

  onSnapshot(
    onNext: (snapshot: QuerySnapshot<T>) => void,
    onError?: (error: Error) => void
  ): () => void {
    let lastDocs: QueryDocumentSnapshot<T>[] = [];
    let subscriptionId: string | null = null;
    let isCancelled = false;

    const queryDef = {
      wheres: this.wheres,
      orderBys: this.orderBys,
      limit: this.limitVal,
    };

    const subscribe = async () => {
      try {
        const clientId = await this.client.getClientId();
        if (isCancelled) return;

        const res = await this.client.request('/pgfire/subscribe', {
          clientId,
          table: this.tableName,
          query: queryDef,
        });

        if (isCancelled) {
          // 若在請求期間已被取消，則發送退訂
          this.client.request('/pgfire/unsubscribe', { subscriptionId: res.subscriptionId }).catch(() => {});
          return;
        }

        subscriptionId = res.subscriptionId;

        // 註冊 SSE 訊息回呼
        this.client.registerSubscriptionCallback(subscriptionId!, (data: any) => {
          if (isCancelled) return;

          const updatedDocs = [...lastDocs];
          for (const change of data.changes) {
            const idx = updatedDocs.findIndex(d => d.id === change.doc.id);
            if (change.type === 'removed') {
              if (idx !== -1) updatedDocs.splice(idx, 1);
            } else if (change.type === 'added') {
              if (idx === -1) {
                updatedDocs.push(new QueryDocumentSnapshot<T>(change.doc.id, change.doc.data as T));
              }
            } else if (change.type === 'modified') {
              if (idx !== -1) {
                updatedDocs[idx] = new QueryDocumentSnapshot<T>(change.doc.id, change.doc.data as T);
              }
            }
          }

          // 重新整理排序（如果有的話，做簡單的 JS 排序以確保與預期相符）
          if (this.orderBys.length > 0) {
            updatedDocs.sort((doc1, doc2) => {
              for (const orderBy of this.orderBys) {
                const val1 = doc1.get(orderBy.field);
                const val2 = doc2.get(orderBy.field);
                
                if (val1 === val2) continue;
                
                const factor = orderBy.direction === 'desc' ? -1 : 1;
                
                // 嘗試將其轉為數字比較
                const num1 = Number(val1);
                const num2 = Number(val2);
                if (!isNaN(num1) && !isNaN(num2)) {
                  return (num1 - num2) * factor;
                }
                
                return String(val1).localeCompare(String(val2)) * factor;
              }
              return 0;
            });
          }

          // 如果有限制 LIMIT，重新擷取對應個數
          const finalDocs = this.limitVal !== undefined ? updatedDocs.slice(0, this.limitVal) : updatedDocs;

          const newSnapshot = new QuerySnapshot<T>(finalDocs, lastDocs);
          lastDocs = finalDocs;
          onNext(newSnapshot);
        });
      } catch (err) {
        if (onError) onError(err as Error);
      }
    };

    subscribe();

    return () => {
      isCancelled = true;
      if (subscriptionId) {
        this.client.deregisterSubscriptionCallback(subscriptionId);
        this.client.request('/pgfire/unsubscribe', { subscriptionId }).catch(() => {});
      }
    };
  }
}

export class DocumentReference<T = DocumentData> {
  constructor(
    public readonly id: string,
    public readonly tableName: string,
    private readonly client: PgFireClient
  ) {}

  get path(): string {
    return `${this.tableName}/${this.id}`;
  }

  async get(): Promise<DocumentSnapshot<T>> {
    const res = await this.client.request('/pgfire/getDoc', {
      table: this.tableName,
      id: this.id,
    });

    return new DocumentSnapshot<T>(res.id, res.data as T, res.exists);
  }

  async set(data: any, options: { merge?: boolean } = {}): Promise<void> {
    await this.client.request('/pgfire/set', {
      table: this.tableName,
      id: this.id,
      data,
      options,
    });
  }

  async update(data: Record<string, any>): Promise<void> {
    await this.client.request('/pgfire/update', {
      table: this.tableName,
      id: this.id,
      data,
    });
  }

  async delete(): Promise<void> {
    await this.client.request('/pgfire/delete', {
      table: this.tableName,
      id: this.id,
    });
  }

  onSnapshot(
    onNext: (snapshot: DocumentSnapshot<T>) => void,
    onError?: (error: Error) => void
  ): () => void {
    let lastDataStr: string | null = null;
    let isCancelled = false;

    // 單一文檔訂閱：藉由包裝為對特定 id 的 Query 訂閱
    const query = new Query<T>(this.client, this.tableName, [
      { field: 'id', op: '==', value: this.id }
    ]);

    const unsubscribe = query.onSnapshot(
      (qSnap) => {
        if (isCancelled) return;
        if (qSnap.empty) {
          const snap = new DocumentSnapshot<T>(this.id, undefined, false);
          const currentStr = 'null';
          if (currentStr !== lastDataStr) {
            lastDataStr = currentStr;
            onNext(snap);
          }
        } else {
          const doc = qSnap.docs[0];
          const snap = new DocumentSnapshot<T>(this.id, doc.data(), true);
          const currentStr = JSON.stringify(doc.data());
          if (currentStr !== lastDataStr) {
            lastDataStr = currentStr;
            onNext(snap);
          }
        }
      },
      onError
    );

    return () => {
      isCancelled = true;
      unsubscribe();
    };
  }
}

export class CollectionReference<T = DocumentData> extends Query<T> {
  constructor(client: PgFireClient, tableName: string) {
    super(client, tableName);
  }

  get id(): string {
    return this.tableName;
  }

  get path(): string {
    return this.tableName;
  }

  doc(id?: string): DocumentReference<T> {
    const docId = id || Math.random().toString(36).substring(2, 15);
    return new DocumentReference<T>(docId, this.tableName, this.client);
  }

  async add(data: T): Promise<DocumentReference<T>> {
    const docId = Math.random().toString(36).substring(2, 15);
    const docRef = this.doc(docId);
    await docRef.set(data);
    return docRef;
  }
}

export interface PgFireClientConfig {
  server: {
    url: string;
    token: string;
  };
}

export class PgFireClient {
  private url: string;
  private token: string;
  private eventSource: any = null;
  private clientId: string | null = null;
  
  // 保存所有活躍訂閱的事件回呼，Map<subscriptionId, callback>
  private subscriptionCallbacks = new Map<string, (data: any) => void>();

  // 用於等待連接成功的 Promise
  private connectionPromise: Promise<string> | null = null;

  constructor(config: PgFireClientConfig) {
    this.url = config.server.url.replace(/\/$/, '');
    this.token = config.server.token;
  }

  /**
   * 建立 SSE 連線並回傳 clientId。若已建立連線，則直接回傳快取的 clientId。
   */
  async getClientId(): Promise<string> {
    if (this.clientId) return this.clientId;
    if (this.connectionPromise) return this.connectionPromise;

    this.connectionPromise = new Promise(async (resolve, reject) => {
      try {
        const EventSourceClass = await this.resolveEventSourceClass();
        const sseUrl = `${this.url}/pgfire/sse?token=${this.token}`;
        
        this.eventSource = new EventSourceClass(sseUrl);

        this.eventSource.addEventListener('connected', (e: any) => {
          try {
            const data = JSON.parse(e.data);
            this.clientId = data.clientId;
            resolve(this.clientId!);
          } catch (err) {
            reject(err);
          }
        });

        this.eventSource.addEventListener('change', (e: any) => {
          try {
            const eventData = JSON.parse(e.data);
            const callback = this.subscriptionCallbacks.get(eventData.subscriptionId);
            if (callback) {
              callback(eventData);
            }
          } catch (err) {
            console.error('Failed to parse SSE change event:', err);
          }
        });

        this.eventSource.onerror = (err: any) => {
          // 在連線失敗時拒絕 Promise
          if (!this.clientId) {
            reject(err);
            this.connectionPromise = null;
          }
        };
      } catch (err) {
        reject(err);
        this.connectionPromise = null;
      }
    });

    return this.connectionPromise;
  }

  private async resolveEventSourceClass(): Promise<any> {
    if (typeof globalThis !== 'undefined' && (globalThis as any).EventSource) {
      return (globalThis as any).EventSource;
    }
    try {
      // 適用於 Node.js 測試環境
      // @ts-ignore
      const module = await import('eventsource');
      return module.default || module;
    } catch {
      throw new Error('EventSource is not defined. Please install "eventsource" or run in a browser.');
    }
  }

  registerSubscriptionCallback(subscriptionId: string, cb: (data: any) => void): void {
    this.subscriptionCallbacks.set(subscriptionId, cb);
  }

  deregisterSubscriptionCallback(subscriptionId: string): void {
    this.subscriptionCallbacks.delete(subscriptionId);
  }

  /**
   * 客戶端 HTTP 請求封裝（自動加入 Auth Header 與將 JSON 序列化）
   */
  async request(endpoint: string, body: any): Promise<any> {
    const targetUrl = `${this.url}${endpoint}`;
    
    // 跨平台 fetch 支援
    const fetchFn = typeof globalThis !== 'undefined' ? globalThis.fetch : fetch;
    if (!fetchFn) {
      throw new Error('fetch is not defined in this environment.');
    }

    const res = await fetchFn(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `Request failed with status ${res.status}`);
    }

    return data;
  }

  collection<T = DocumentData>(name: string): CollectionReference<T> {
    return new CollectionReference<T>(this, name);
  }

  async terminate(): Promise<void> {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.clientId = null;
    this.connectionPromise = null;
    this.subscriptionCallbacks.clear();
  }
}
