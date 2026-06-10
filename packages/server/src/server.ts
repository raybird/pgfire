import http from 'node:http';
import { randomUUID } from 'node:crypto';
import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { Pool, Client } from 'pg';
import { 
  TriggerManager, 
  NotificationListener, 
  NotificationPayload,
  compileQuery,
  compileSet,
  compileUpdate,
  reviveFieldValues
} from '@pgfire/core';
import { AuthManager, TokenPayload } from './auth.js';
import { SubscriptionManager } from './subscription.js';

export interface PgFireServerConfig {
  port?: number;
  host?: string;
  db: any; // pg.PoolConfig
  auth: {
    secret: string;
    tokenExpiry?: string;
    required?: boolean;
  };
  cors?: {
    origin?: string | string[];
  };
}

export class PgFireServer {
  private app: Express;
  public pool!: Pool;
  private listenClient!: Client;
  private listener!: NotificationListener;
  
  private authManager: AuthManager;
  private subscriptionManager!: SubscriptionManager;
  private httpServer?: http.Server;
  
  // 保存所有活躍的 SSE 客戶端連接
  private clients = new Map<string, Response>();
  
  // 統計整個 Server 對各 Table 的訂閱數量
  private tableSubscribersCount = new Map<string, number>();

  constructor(private config: PgFireServerConfig) {
    this.authManager = new AuthManager(
      config.auth.secret,
      config.auth.tokenExpiry || '24h'
    );
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    // 跨來源設定
    const corsOrigin = this.config.cors?.origin || '*';
    this.app.use(cors({ origin: corsOrigin }));
    this.app.use(express.json());
  }

  /**
   * JWT 驗證中介軟體
   */
  private authenticate = (req: Request, res: Response, next: NextFunction): void => {
    if (this.config.auth.required === false) {
      // 模擬未啟用驗證的 payload
      (req as any).user = { sub: 'anonymous' };
      return next();
    }

    try {
      let token = req.query.token as string;
      if (!token) {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
          token = authHeader.substring(7);
        }
      }

      if (!token) {
        res.status(401).json({ error: 'Unauthorized: Missing token' });
        return;
      }

      const decoded = this.authManager.verifyToken(token);
      (req as any).user = decoded;
      next();
    } catch (err) {
      res.status(401).json({ error: `Unauthorized: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  private setupRoutes(): void {
    // 1. SSE 連線端點
    this.app.get('/pgfire/sse', this.authenticate, (req: Request, res: Response) => {
      const user = (req as any).user as TokenPayload;
      const requestedClientId = req.query.clientId as string;
      
      // 決定使用重連的 clientId 或是分配新 ID
      const clientId = requestedClientId || `c_${randomUUID().replace(/-/g, '').substring(0, 12)}`;
      const isReconnected = !!requestedClientId;

      // 設置 SSE 必要的 Response Header
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      // 保持 TCP 連線
      res.write('\n');

      this.clients.set(clientId, res);

      // 發送 connected 事件
      this.sendSseEvent(clientId, 'connected', {
        clientId,
        reconnected: isReconnected,
      });

      req.on('close', () => {
        this.clients.delete(clientId);
        
        // 清除該客戶端的所有訂閱
        const removedSubIds = this.subscriptionManager.removeClient(clientId);
        for (const subId of removedSubIds) {
          // 當訂閱被清除，需要遞減並可能停用 DB 觸發器
          // 這裡簡單從 subId 去回推 table 是不划算的，所以我們在下面 deregister 處理
        }
      });
    });

    // 2. 新增訂閱
    this.app.post('/pgfire/subscribe', this.authenticate, async (req: Request, res: Response) => {
      const user = (req as any).user as TokenPayload;
      const { table, query, clientId } = req.body;

      if (!table || !query || !clientId) {
        res.status(400).json({ error: 'Missing required fields: table, query, clientId' });
        return;
      }

      // 檢查 table 權限
      if (!this.authManager.canAccess(user, table, 'read')) {
        res.status(403).json({ error: `Forbidden: Read access denied for table "${table}"` });
        return;
      }

      try {
        // 先啟用資料庫觸發器
        await this.registerTableSubscription(table);

        const { subscriptionId, initialDocs } = await this.subscriptionManager.addSubscription(
          clientId,
          table,
          query
        );

        res.status(200).json({ subscriptionId });

        // 立刻透過 SSE 向該用戶端發送初始 Snapshot
        if (initialDocs.length > 0) {
          this.sendSseEvent(clientId, 'change', {
            subscriptionId,
            changes: initialDocs.map(doc => ({
              type: 'added',
              doc,
            })),
          });
        }
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // 3. 批次重連訂閱
    this.app.post('/pgfire/resubscribe', this.authenticate, async (req: Request, res: Response) => {
      const user = (req as any).user as TokenPayload;
      const { subscriptions, clientId } = req.body;

      if (!Array.isArray(subscriptions) || !clientId) {
        res.status(400).json({ error: 'Invalid payload: missing subscriptions array or clientId' });
        return;
      }

      try {
        const results = [];
        for (const subReq of subscriptions) {
          const { table, query } = subReq;
          
          if (!this.authManager.canAccess(user, table, 'read')) {
            continue; // 忽略無權限的
          }

          await this.registerTableSubscription(table);

          const { subscriptionId, initialDocs } = await this.subscriptionManager.addSubscription(
            clientId,
            table,
            query
          );

          results.push({ subscriptionId });

          if (initialDocs.length > 0) {
            this.sendSseEvent(clientId, 'change', {
              subscriptionId,
              changes: initialDocs.map(doc => ({
                type: 'added',
                doc,
              })),
            });
          }
        }

        res.status(200).json({ results });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // 4. 取消訂閱
    this.app.post('/pgfire/unsubscribe', this.authenticate, async (req: Request, res: Response) => {
      const { subscriptionId } = req.body;
      if (!subscriptionId) {
        res.status(400).json({ error: 'Missing subscriptionId' });
        return;
      }

      // 我們在移除前需要知道這對應哪個 table 以減去訂閱計數
      // 這裡直接使用 subscriptionManager 中的數據
      const sub = (this.subscriptionManager as any).subscriptions.get(subscriptionId);
      if (sub) {
        await this.deregisterTableSubscription(sub.table);
        this.subscriptionManager.removeSubscription(subscriptionId);
      }

      res.status(200).json({ success: true });
    });

    // 5. 執行客戶端 Query 查詢
    this.app.post('/pgfire/get', this.authenticate, async (req: Request, res: Response) => {
      const user = (req as any).user as TokenPayload;
      const { table, query } = req.body;

      if (!table || !query) {
        res.status(400).json({ error: 'Missing required fields: table, query' });
        return;
      }

      if (!this.authManager.canAccess(user, table, 'read')) {
        res.status(403).json({ error: `Forbidden: Read access denied for table "${table}"` });
        return;
      }

      try {
        const compiled = compileQuery({ table, ...query });
        const result = await this.pool.query(compiled.text, compiled.values);
        res.status(200).json({ docs: result.rows.map(row => ({ id: row.id, data: row.data })) });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // 6. 查詢單一文檔
    this.app.post('/pgfire/getDoc', this.authenticate, async (req: Request, res: Response) => {
      const user = (req as any).user as TokenPayload;
      const { table, id } = req.body;

      if (!table || !id) {
        res.status(400).json({ error: 'Missing required fields: table, id' });
        return;
      }

      if (!this.authManager.canAccess(user, table, 'read')) {
        res.status(403).json({ error: `Forbidden: Read access denied for table "${table}"` });
        return;
      }

      try {
        const escapedTable = `"${table}"`;
        const sql = `SELECT data FROM ${escapedTable} WHERE id = $1`;
        const result = await this.pool.query(sql, [id]);
        
        if (result.rows.length === 0) {
          res.status(200).json({ id, data: null, exists: false });
        } else {
          res.status(200).json({ id, data: result.rows[0].data, exists: true });
        }
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // 7. 寫入或合併文檔
    this.app.post('/pgfire/set', this.authenticate, async (req: Request, res: Response) => {
      const user = (req as any).user as TokenPayload;
      const { table, id, options } = req.body;
      const rawData = req.body.data;

      if (!table || !id || rawData === undefined) {
        res.status(400).json({ error: 'Missing required fields: table, id, data' });
        return;
      }

      if (!this.authManager.canAccess(user, table, 'write')) {
        res.status(403).json({ error: `Forbidden: Write access denied for table "${table}"` });
        return;
      }

      try {
        const data = reviveFieldValues(rawData);
        const compiled = compileSet(table, id, data, options);
        await this.pool.query(compiled.text, compiled.values);
        res.status(200).json({ success: true });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // 8. 局部更新文檔
    this.app.post('/pgfire/update', this.authenticate, async (req: Request, res: Response) => {
      const user = (req as any).user as TokenPayload;
      const { table, id } = req.body;
      const rawData = req.body.data;

      if (!table || !id || !rawData) {
        res.status(400).json({ error: 'Missing required fields: table, id, data' });
        return;
      }

      if (!this.authManager.canAccess(user, table, 'write')) {
        res.status(403).json({ error: `Forbidden: Write access denied for table "${table}"` });
        return;
      }

      try {
        const data = reviveFieldValues(rawData);
        const compiled = compileUpdate(table, id, data);
        await this.pool.query(compiled.text, compiled.values);
        res.status(200).json({ success: true });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // 9. 刪除文檔
    this.app.post('/pgfire/delete', this.authenticate, async (req: Request, res: Response) => {
      const user = (req as any).user as TokenPayload;
      const { table, id } = req.body;

      if (!table || !id) {
        res.status(400).json({ error: 'Missing required fields: table, id' });
        return;
      }

      if (!this.authManager.canAccess(user, table, 'write')) {
        res.status(403).json({ error: `Forbidden: Write access denied for table "${table}"` });
        return;
      }

      try {
        const escapedTable = `"${table}"`;
        const sql = `DELETE FROM ${escapedTable} WHERE id = $1`;
        await this.pool.query(sql, [id]);
        res.status(200).json({ success: true });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  private sendSseEvent(clientId: string, event: string, data: any): void {
    const res = this.clients.get(clientId);
    if (!res) return;

    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  private async registerTableSubscription(tableName: string): Promise<void> {
    const count = this.tableSubscribersCount.get(tableName) || 0;
    this.tableSubscribersCount.set(tableName, count + 1);

    if (count === 0) {
      const triggerMgr = new TriggerManager(this.pool);
      await triggerMgr.enableTriggerForTable(tableName);
    }
  }

  private async deregisterTableSubscription(tableName: string): Promise<void> {
    const count = this.tableSubscribersCount.get(tableName) || 0;
    if (count <= 1) {
      this.tableSubscribersCount.delete(tableName);
      const triggerMgr = new TriggerManager(this.pool);
      await triggerMgr.disableTriggerForTable(tableName);
    } else {
      this.tableSubscribersCount.set(tableName, count - 1);
    }
  }

  /**
   * 啟動獨立 HTTP 伺服器
   */
  async start(): Promise<void> {
    this.pool = new Pool(this.config.db);
    
    // 初始化專用 Listen Client 監聽
    this.listenClient = new Client(this.config.db);
    await this.listenClient.connect();

    this.listener = new NotificationListener(this.listenClient);
    await this.listener.start();

    // 安裝資料庫 trigger function
    const triggerMgr = new TriggerManager(this.pool);
    await triggerMgr.setupTriggerFunction();

    this.subscriptionManager = new SubscriptionManager(this.pool);

    // 監聽 pgfire_changes 並派發
    this.listener.on('change', async (payload: NotificationPayload) => {
      try {
        const sseEvents = await this.subscriptionManager.handleDbNotification(payload);
        for (const evt of sseEvents) {
          this.sendSseEvent(evt.clientId, evt.event, evt.data);
        }
      } catch (err) {
        console.error('Failed to handle DB notification:', err);
      }
    });

    const port = this.config.port || 3000;
    const host = this.config.host || '0.0.0.0';

    this.httpServer = this.app.listen(port, host, () => {
      // 伺服器啟動成功
    });
  }

  /**
   * 停止伺服器並釋放連線
   */
  async stop(): Promise<void> {
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
    }
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

  /**
   * 將 PgFire 的 Express Router 與監聽器附加到既存的 HTTP 伺服器
   */
  async attachToServer(httpServer: http.Server): Promise<void> {
    this.pool = new Pool(this.config.db);
    
    this.listenClient = new Client(this.config.db);
    await this.listenClient.connect();

    this.listener = new NotificationListener(this.listenClient);
    await this.listener.start();

    const triggerMgr = new TriggerManager(this.pool);
    await triggerMgr.setupTriggerFunction();

    this.subscriptionManager = new SubscriptionManager(this.pool);

    this.listener.on('change', async (payload: NotificationPayload) => {
      try {
        const sseEvents = await this.subscriptionManager.handleDbNotification(payload);
        for (const evt of sseEvents) {
          this.sendSseEvent(evt.clientId, evt.event, evt.data);
        }
      } catch (err) {
        console.error('Failed to handle DB notification:', err);
      }
    });

    // 劫持 request listener
    const listeners = httpServer.listeners('request');
    httpServer.removeAllListeners('request');
    httpServer.on('request', (req: any, res: any) => {
      this.app(req, res, () => {
        for (const listener of listeners) {
          listener(req, res);
        }
      });
    });
  }
}
