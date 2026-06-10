import { FieldValue, FieldValueType } from './types.js';

export interface CompiledWrite {
  text: string;
  values: any[];
}

const TABLE_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function validateTableName(table: string): void {
  if (!TABLE_NAME_REGEX.test(table)) {
    throw new Error(`Invalid table name: "${table}"`);
  }
}

/**
 * 將 Document 更新資料（可能包含點號路徑與 FieldValue 哨兵值）編譯成 PostgreSQL UPDATE 語法中的 SET data = ... 表達式。
 * 
 * 我們會從 data = ... 開始，一層層巢狀套用 jsonb_set 或其他 JSONB 函數。
 */
export function compileUpdate(
  table: string,
  docId: string,
  updateData: Record<string, any>
): CompiledWrite {
  validateTableName(table);
  const escapedTable = `"${table}"`;

  const values: any[] = [];
  let paramCount = 1;
  const nextParam = () => `$${paramCount++}`;

  const docIdParam = nextParam();
  values.push(docId);

  let dataExpression = 'data';

  // 排序鍵，確保產生的 SQL 順序一致方便測試，且優先處理 deleteField 以免後面更新了又被刪除
  const keys = Object.keys(updateData).sort((a, b) => {
    const isDeleteA = updateData[a] instanceof FieldValue && updateData[a].type === 'deleteField';
    const isDeleteB = updateData[b] instanceof FieldValue && updateData[b].type === 'deleteField';
    if (isDeleteA && !isDeleteB) return -1;
    if (!isDeleteA && isDeleteB) return 1;
    return a.localeCompare(b);
  });

  for (const key of keys) {
    const value = updateData[key];
    const pathParts = key.split('.');

    if (value instanceof FieldValue) {
      const type = value.type;
      switch (type) {
        case 'deleteField': {
          dataExpression = `(${dataExpression} #- '{${pathParts.join(',')}}')`;
          break;
        }
        case 'serverTimestamp': {
          const timeParam = nextParam();
          values.push(new Date().toISOString());
          dataExpression = `jsonb_set(${dataExpression}, '{${pathParts.join(',')}}', to_jsonb(${timeParam}::text))`;
          break;
        }
        case 'increment': {
          const valParam = nextParam();
          values.push(Number(value.operand));
          const pathText = pathParts.join(',');
          dataExpression = `jsonb_set(${dataExpression}, '{${pathText}}', to_jsonb(COALESCE((${dataExpression} #>> '{${pathText}}')::numeric, 0) + ${valParam}::numeric))`;
          break;
        }
        case 'arrayUnion': {
          const valParam = nextParam();
          // operand 預設是一個陣列，代表要聯集的元素
          const elements = Array.isArray(value.operand) ? value.operand : [value.operand];
          values.push(JSON.stringify(elements));

          const pathText = pathParts.join(',');
          dataExpression = `jsonb_set(${dataExpression}, '{${pathText}}', COALESCE(${dataExpression} #> '{${pathText}}', '[]'::jsonb) || ${valParam}::jsonb)`;
          break;
        }
        case 'arrayRemove': {
          const valParam = nextParam();
          const elements = Array.isArray(value.operand) ? value.operand : [value.operand];
          // 將每個要移除的元素序列化為 jsonb 並做成 pg 陣列
          values.push(elements.map(el => JSON.stringify(el)));

          const pathText = pathParts.join(',');
          dataExpression = `jsonb_set(${dataExpression}, '{${pathText}}', (
            SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
            FROM jsonb_array_elements(COALESCE(${dataExpression} #> '{${pathText}}', '[]'::jsonb)) elem
            WHERE NOT (elem::text = ANY(${valParam}::text[]))
          ))`;
          break;
        }
      }
    } else {
      // 一般值更新
      const valParam = nextParam();
      values.push(JSON.stringify(value));
      dataExpression = `jsonb_set(${dataExpression}, '{${pathParts.join(',')}}', ${valParam}::jsonb)`;
    }
  }

  const sql = `UPDATE ${escapedTable} SET data = ${dataExpression}, _updated_at = now() WHERE id = ${docIdParam}`;

  return {
    text: sql,
    values,
  };
}

/**
 * 編譯 set 覆寫或合併寫入 SQL。
 */
export function compileSet(
  table: string,
  docId: string,
  data: Record<string, any>,
  options: { merge?: boolean } = {}
): CompiledWrite {
  validateTableName(table);
  const escapedTable = `"${table}"`;

  const values: any[] = [];
  let paramCount = 1;
  const nextParam = () => `$${paramCount++}`;

  const docIdParam = nextParam();
  values.push(docId);

  if (options.merge) {
    // 具有 merge 功能的 set
    // 我們可以用 INSERT ... ON CONFLICT (id) DO UPDATE 的形式，
    // 其中 DO UPDATE 裡面的 SET data = ... 表達式就跟 compileUpdate 一樣
    const updateWrite = compileUpdate(table, docId, data);
    // 我們需要把 updateWrite 裡的 docId 參數剝離出來，重新規劃參數順序
    // 比較簡單的做法是直接利用 compileUpdate 的 SQL，但在 insert 時需要 docId 與初始 data。
    // 其實，簡單的 merge set，如果資料庫中沒有文檔，初始化 data 就是我們要寫入的內容（過濾掉 deleteField，計算哨兵值）。
    // 在 PostgreSQL 中，可以直接這樣做：
    // 1. 將 data 過濾掉 FieldValue 轉換為基礎 JSONB
    const initialData: Record<string, any> = {};
    for (const key of Object.keys(data)) {
      const val = data[key];
      if (val instanceof FieldValue) {
        if (val.type === 'deleteField') continue;
        if (val.type === 'serverTimestamp') {
          initialData[key] = new Date().toISOString();
        } else if (val.type === 'increment') {
          initialData[key] = val.operand;
        } else if (val.type === 'arrayUnion') {
          initialData[key] = Array.isArray(val.operand) ? val.operand : [val.operand];
        } else if (val.type === 'arrayRemove') {
          initialData[key] = [];
        }
      } else {
        initialData[key] = val;
      }
    }

    const dataParam = nextParam();
    values.push(JSON.stringify(initialData));

    // 當 CONFLICT 發生時，我們執行跟 update 一樣的表達式。
    // 為了將 update 邏輯串進來，我們自己建立一個 EXCLUDED update SQL
    let updateExpression = 'data';
    const keys = Object.keys(data).sort((a, b) => a.localeCompare(b));
    
    for (const key of keys) {
      const value = data[key];
      const pathParts = key.split('.');

      if (value instanceof FieldValue) {
        switch (value.type) {
          case 'deleteField': {
            updateExpression = `(${updateExpression} #- '{${pathParts.join(',')}}')`;
            break;
          }
          case 'serverTimestamp': {
            const timeParam = nextParam();
            values.push(new Date().toISOString());
            updateExpression = `jsonb_set(${updateExpression}, '{${pathParts.join(',')}}', to_jsonb(${timeParam}::text))`;
            break;
          }
          case 'increment': {
            const valParam = nextParam();
            values.push(Number(value.operand));
            const pathText = pathParts.join(',');
            updateExpression = `jsonb_set(${updateExpression}, '{${pathText}}', to_jsonb(COALESCE((${updateExpression} #>> '{${pathText}}')::numeric, 0) + ${valParam}::numeric))`;
            break;
          }
          case 'arrayUnion': {
            const valParam = nextParam();
            const elements = Array.isArray(value.operand) ? value.operand : [value.operand];
            values.push(JSON.stringify(elements));
            const pathText = pathParts.join(',');
            updateExpression = `jsonb_set(${updateExpression}, '{${pathText}}', COALESCE(${updateExpression} #> '{${pathText}}', '[]'::jsonb) || ${valParam}::jsonb)`;
            break;
          }
          case 'arrayRemove': {
            const valParam = nextParam();
            const elements = Array.isArray(value.operand) ? value.operand : [value.operand];
            values.push(elements.map(el => JSON.stringify(el)));
            const pathText = pathParts.join(',');
            updateExpression = `jsonb_set(${updateExpression}, '{${pathText}}', (
              SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
              FROM jsonb_array_elements(COALESCE(${updateExpression} #> '{${pathText}}', '[]'::jsonb)) elem
              WHERE NOT (elem::text = ANY(${valParam}::text[]))
            ))`;
            break;
          }
        }
      } else {
        const valParam = nextParam();
        values.push(JSON.stringify(value));
        updateExpression = `jsonb_set(${updateExpression}, '{${pathParts.join(',')}}', ${valParam}::jsonb)`;
      }
    }

    const sql = `
      INSERT INTO ${escapedTable} (id, data, _created_at, _updated_at)
      VALUES (${docIdParam}, ${dataParam}::jsonb, now(), now())
      ON CONFLICT (id) DO UPDATE SET data = ${updateExpression}, _updated_at = now()
    `.trim().replace(/\s+/g, ' ');

    return {
      text: sql,
      values,
    };
  } else {
    // 沒有 merge 的 set，直接覆寫
    const dataParam = nextParam();
    values.push(JSON.stringify(data));

    const sql = `
      INSERT INTO ${escapedTable} (id, data, _created_at, _updated_at)
      VALUES (${docIdParam}, ${dataParam}::jsonb, now(), now())
      ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, _updated_at = now()
    `.trim().replace(/\s+/g, ' ');

    return {
      text: sql,
      values,
    };
  }
}
