# PgFire (PgFire Monorepo)

PgFire 是一個基於 PostgreSQL `LISTEN/NOTIFY` 機制並提供類似 Firestore API 介面的 TypeScript 即時（Real-time）訂閱與資料同步程式庫。

本專案採用 pnpm workspaces 進行多包（Monorepo）管理，將各個功能層解耦為獨立套件。

---

## 📂 專案目錄與套件架構

*   **[`@pgfire/core`](file:///home/raybird/Documents/RCodes/fire-sql/packages/core/)** — 核心引擎：包含安全防注入的 SQL 查詢與寫入產生器、資料庫 Trigger 部署管理器、LISTEN/NOTIFY 專屬長連線監聽器，以及跨網路 `FieldValue` 哨兵值序列化工具。
*   **[`@pgfire/embedded`](file:///home/raybird/Documents/RCodes/fire-sql/packages/embedded/)** — 嵌入式直連模式：後端對後端專用。不透過 HTTP，直接使用連接池與資料庫互動，在收到資料庫變更通知時於記憶體自動執行 Snapshot Diff 以派發即時變更。
*   **[`@pgfire/server`](file:///home/raybird/Documents/RCodes/fire-sql/packages/server/)** — HTTP & SSE 伺服器：基於 Express 與 JWT，提供 Scoped 表權限控管與 SSE 長連線訂閱，並對資料庫異動執行 SQL Recheck 進行變更路由分發。
*   **[`@pgfire/client`](file:///home/raybird/Documents/RCodes/fire-sql/packages/client/)** — 客戶端 SDK：可用於瀏覽器或 Node 端。透過 HTTP 與 SSE 長連線與 `@pgfire/server` 互動，自動於客戶端快取並計算 Added/Modified/Removed Snapshot 變更。
*   **[`@pgfire/cli`](file:///home/raybird/Documents/RCodes/fire-sql/packages/cli/)** — 命令行工具：提供資料庫初始化觸發器安裝、JWT Token 簽發以及伺服器啟動命令。

---

## 🛠️ 開發指引 (Development Guide)

### 1. 安裝相依性
在專案根目錄下使用 `pnpm` 一鍵安裝並完成 Monorepo 各套件的軟連結：
```bash
pnpm install
```

### 2. 建置與編譯
將所有 TypeScript 套件編譯至 `dist/` 目錄：
```bash
pnpm build
```

### 3. 執行單元測試
使用 `vitest` 執行全專案的單元測試（包含 AST 轉譯、Snapshot Diff 比對、JWT 權限過濾等，共計 40 個測試項目，皆已通過 Mock 處理不需依賴本地實體資料庫）：
```bash
pnpm test
```

---

## 🚀 快速開始範例

### 第一步：初始化資料庫 (使用 CLI)
首先在環境變數配置您的 PostgreSQL 連線資訊，並透過 CLI 安裝必要的觸發器函數：
```bash
export PGHOST=localhost
export PGDATABASE=pgfire
export PGUSER=postgres
export PGPASSWORD=secret

# 初始化資料庫，安裝 pgfire_notify_trigger 觸發器函數
pnpm --filter @pgfire/cli pgfire init
```

### 第二步：啟動伺服器端
您可以使用 CLI 快速啟動獨立的 SSE HTTP 伺服器，或在程式碼中載入它：
```bash
# 啟動伺服器端（預設監聽 3000 埠）
export JWT_SECRET=my-super-secret-key
pnpm --filter @pgfire/cli pgfire server start
```

### 第三步：產生客戶端 JWT Token
```bash
# 產生一個允許存取 users 表的唯讀 Token
pnpm --filter @pgfire/cli pgfire auth token --sub client-123 --tables users --permissions read --secret my-super-secret-key
```

### 第四步：使用客戶端 SDK
```typescript
import { PgFireClient, increment, arrayUnion } from '@pgfire/client';

// 1. 初始化 Client
const client = new PgFireClient({
  server: {
    url: 'http://localhost:3000',
    token: 'your-generated-jwt-token-here',
  },
});

const users = client.collection('users');

// 2. 寫入與局部原子更新 (支援哨兵值與點號巢狀路徑)
await users.doc('user-1').set({ 
  name: 'Alice', 
  profile: { age: 20 },
  tags: ['newbie']
});

await users.doc('user-1').update({
  'profile.age': increment(1), // 點號路徑更新為 21
  tags: arrayUnion('active')    // 聯集陣列 tags 變為 ['newbie', 'active']
});

// 3. 鏈式條件查詢
const snapshot = await users
  .where('profile.age', '>=', 18)
  .orderBy('profile.age', 'desc')
  .limit(10)
  .get();

snapshot.forEach(doc => {
  console.log(doc.id, doc.data());
});

// 4. 監聽即時變更 (SSE)
const unsubscribe = users
  .where('profile.age', '>=', 18)
  .onSnapshot((snapshot) => {
    console.log(`收到變更！目前共有 ${snapshot.size} 筆符合的文件。`);
    snapshot.docChanges().forEach(change => {
      console.log(`異動類型: ${change.type}`, change.doc.id, change.doc.data());
    });
  });

// 停止監聽
// unsubscribe();
```

---

## 🛡️ 安全防護與注入防範

1.  **資料表與欄位防範**：所有傳入的 table 名稱與點號欄位路徑，內部皆通過正則表達式 `/^[a-zA-Z_][a-zA-Z0-9_.]*$/` 強制校驗，防止惡意 SQL 拼接字串。
2.  **參數化查詢**：所有查詢條件、LIMIT 與更新欄位值均以 PostgreSQL 參數化（如 `$1`, `$2`...）發送給資料庫驅動，100% 杜絕 SQL 注入攻擊。