import { randomUUID } from 'node:crypto';
import { Pool, Client } from 'pg';
import { 
  QueryRequest, 
  WhereCondition, 
  OrderByCondition, 
  compileQuery,
  compileUpdate,
  compileSet,
  TriggerManager,
  NotificationListener,
  DocumentData,
  WhereFilterOp,
  OrderByDirection,
  FieldValue
} from '@pgfire/core';

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
    protected readonly db: PgFireEmbedded,
    public readonly tableName: string,
    protected readonly wheres: WhereCondition[] = [],
    protected readonly orderBys: OrderByCondition[] = [],
    protected readonly limitVal?: number
  ) {}

  where(field: string, op: WhereFilterOp, value: any): Query<T> {
    return new Query<T>(
      this.db,
      this.tableName,
      [...this.wheres, { field, op, value }],
      this.orderBys,
      this.limitVal
    );
  }

  orderBy(field: string, direction: OrderByDirection = 'asc'): Query<T> {
    return new Query<T>(
      this.db,
      this.tableName,
      this.wheres,
      [...this.orderBys, { field, direction }],
      this.limitVal
    );
  }

  limit(n: number): Query<T> {
    return new Query<T>(this.db, this.tableName, this.wheres, this.orderBys, n);
  }

  async get(): Promise<QuerySnapshot<T>> {
    const request: QueryRequest = {
      table: this.tableName,
      wheres: this.wheres,
      orderBys: this.orderBys,
      limit: this.limitVal,
    };
    
    const compiled = compileQuery(request);
    const result = await this.db.pool.query(compiled.text, compiled.values);
    
    const docs = result.rows.map(
      (row: any) => new QueryDocumentSnapshot<T>(row.id, row.data as T)
    );
    
    return new QuerySnapshot<T>(docs);
  }

  onSnapshot(
    onNext: (snapshot: QuerySnapshot<T>) => void,
    onError?: (error: Error) => void
  ): () => void {
    let lastSnapshot: QuerySnapshot<T> | null = null;
    let isCancelled = false;

    const runQuery = async (isInitial = false) => {
      if (isCancelled) return;
      try {
        const request: QueryRequest = {
          table: this.tableName,
          wheres: this.wheres,
          orderBys: this.orderBys,
          limit: this.limitVal,
        };
        const compiled = compileQuery(request);
        const result = await this.db.pool.query(compiled.text, compiled.values);
        
        const docs = result.rows.map(
          (row: any) => new QueryDocumentSnapshot<T>(row.id, row.data as T)
        );

        if (isCancelled) return;

        const newSnapshot = new QuerySnapshot<T>(docs, lastSnapshot?.docs);
        
        if (isInitial || newSnapshot.docChanges().length > 0) {
          lastSnapshot = newSnapshot;
          onNext(newSnapshot);
        }
      } catch (err) {
        if (onError) onError(err as Error);
      }
    };

    runQuery(true);

    this.db.registerTableSubscription(this.tableName).catch((err) => {
      if (onError) onError(err);
    });

    const changeListener = () => {
      runQuery(false);
    };

    this.db.listenerEmitter.on(`table:${this.tableName}`, changeListener);

    return () => {
      isCancelled = true;
      this.db.listenerEmitter.off(`table:${this.tableName}`, changeListener);
      this.db.deregisterTableSubscription(this.tableName).catch(() => {});
    };
  }
}

export class DocumentReference<T = DocumentData> {
  constructor(
    public readonly id: string,
    public readonly tableName: string,
    private readonly db: PgFireEmbedded
  ) {}

  get path(): string {
    return `${this.tableName}/${this.id}`;
  }

  async get(): Promise<DocumentSnapshot<T>> {
    const escapedTable = `"${this.tableName}"`;
    const sql = `SELECT data FROM ${escapedTable} WHERE id = $1`;
    const result = await this.db.pool.query(sql, [this.id]);
    
    if (result.rows.length === 0) {
      return new DocumentSnapshot<T>(this.id, undefined, false);
    }
    
    return new DocumentSnapshot<T>(this.id, result.rows[0].data as T, true);
  }

  async set(data: any, options: { merge?: boolean } = {}): Promise<void> {
    const compiled = compileSet(this.tableName, this.id, data, options);
    await this.db.pool.query(compiled.text, compiled.values);
  }

  async update(data: Record<string, any>): Promise<void> {
    const compiled = compileUpdate(this.tableName, this.id, data);
    await this.db.pool.query(compiled.text, compiled.values);
  }

  async delete(): Promise<void> {
    const escapedTable = `"${this.tableName}"`;
    const sql = `DELETE FROM ${escapedTable} WHERE id = $1`;
    await this.db.pool.query(sql, [this.id]);
  }

  onSnapshot(
    onNext: (snapshot: DocumentSnapshot<T>) => void,
    onError?: (error: Error) => void
  ): () => void {
    let lastDataStr: string | null = null;
    let isCancelled = false;

    const runQuery = async (isInitial = false) => {
      if (isCancelled) return;
      try {
        const snap = await this.get();
        if (isCancelled) return;

        const currentDataStr = snap.exists ? JSON.stringify(snap.data()) : 'null';
        if (isInitial || currentDataStr !== lastDataStr) {
          lastDataStr = currentDataStr;
          onNext(snap);
        }
      } catch (err) {
        if (onError) onError(err as Error);
      }
    };

    runQuery(true);

    this.db.registerTableSubscription(this.tableName).catch((err) => {
      if (onError) onError(err);
    });

    const changeListener = () => {
      runQuery(false);
    };

    this.db.listenerEmitter.on(`table:${this.tableName}`, changeListener);

    return () => {
      isCancelled = true;
      this.db.listenerEmitter.off(`table:${this.tableName}`, changeListener);
      this.db.deregisterTableSubscription(this.tableName).catch(() => {});
    };
  }
}

export class CollectionReference<T = DocumentData> extends Query<T> {
  constructor(db: PgFireEmbedded, tableName: string) {
    super(db, tableName);
  }

  get id(): string {
    return this.tableName;
  }

  get path(): string {
    return this.tableName;
  }

  doc(id?: string): DocumentReference<T> {
    const docId = id || randomUUID();
    return new DocumentReference<T>(docId, this.tableName, this.db);
  }

  async add(data: T): Promise<DocumentReference<T>> {
    const docId = randomUUID();
    const docRef = this.doc(docId);
    await docRef.set(data);
    return docRef;
  }
}

export class PgFireEmbedded {
  public pool!: Pool;
  private listenClient!: Client;
  private listener!: NotificationListener;
  
  private tableSubscribersCount = new Map<string, number>();
  
  constructor(private poolConfig: any) {}

  get listenerEmitter(): NotificationListener {
    return this.listener;
  }

  async initialize(): Promise<void> {
    this.pool = new Pool(this.poolConfig);
    
    this.listenClient = new Client(this.poolConfig);
    await this.listenClient.connect();
    
    this.listener = new NotificationListener(this.listenClient);
    await this.listener.start();

    const triggerMgr = new TriggerManager(this.pool);
    await triggerMgr.setupTriggerFunction();
  }

  async close(): Promise<void> {
    if (this.listener) {
      await this.listener.stop();
    }
    if (this.listenClient) {
      await this.listenClient.end();
    }
    if (this.pool) {
      await this.pool.end();
    }
  }

  collection<T = DocumentData>(name: string): CollectionReference<T> {
    return new CollectionReference<T>(this, name);
  }

  async registerTableSubscription(tableName: string): Promise<void> {
    const count = this.tableSubscribersCount.get(tableName) || 0;
    this.tableSubscribersCount.set(tableName, count + 1);

    if (count === 0) {
      const triggerMgr = new TriggerManager(this.pool);
      await triggerMgr.enableTriggerForTable(tableName);
    }
  }

  async deregisterTableSubscription(tableName: string): Promise<void> {
    const count = this.tableSubscribersCount.get(tableName) || 0;
    if (count <= 1) {
      this.tableSubscribersCount.delete(tableName);
      const triggerMgr = new TriggerManager(this.pool);
      await triggerMgr.disableTriggerForTable(tableName);
    } else {
      this.tableSubscribersCount.set(tableName, count - 1);
    }
  }
}
