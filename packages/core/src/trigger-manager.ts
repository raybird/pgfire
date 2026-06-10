import { ClientBase } from 'pg';

const TABLE_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function validateTableName(tableName: string): void {
  if (!TABLE_NAME_REGEX.test(tableName)) {
    throw new Error(`Invalid table name: "${tableName}"`);
  }
}

export const NOTIFY_TRIGGER_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION pgfire_notify_trigger() RETURNS trigger AS $$
DECLARE
  payload jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    payload = jsonb_build_object(
      'table', TG_TABLE_NAME,
      'id', OLD.id,
      'op', 'DELETE',
      'data', NULL,
      'old_data', to_jsonb(OLD.data),
      'txid', txid_current(),
      'timestamp', now()::text
    );
  ELSIF TG_OP = 'UPDATE' THEN
    payload = jsonb_build_object(
      'table', TG_TABLE_NAME,
      'id', NEW.id,
      'op', 'UPDATE',
      'data', to_jsonb(NEW.data),
      'old_data', to_jsonb(OLD.data),
      'txid', txid_current(),
      'timestamp', now()::text
    );
  ELSE -- INSERT
    payload = jsonb_build_object(
      'table', TG_TABLE_NAME,
      'id', NEW.id,
      'op', 'INSERT',
      'data', to_jsonb(NEW.data),
      'old_data', NULL,
      'txid', txid_current(),
      'timestamp', now()::text
    );
  END IF;

  PERFORM pg_notify('pgfire_changes', payload::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
`.trim();

export interface Queryable {
  query: (...args: any[]) => Promise<any>;
}

export class TriggerManager {
  constructor(private client: Queryable) {}

  /**
   * 在資料庫中安裝 pgfire_notify_trigger() 觸發器函數。
   */
  async setupTriggerFunction(): Promise<void> {
    await this.client.query(NOTIFY_TRIGGER_FUNCTION_SQL);
  }

  /**
   * 為指定的資料表啟用 PgFire 異動通知觸發器。
   * 會先移除已存在的觸發器再重新建立，以防重複。
   */
  async enableTriggerForTable(tableName: string): Promise<void> {
    validateTableName(tableName);
    const escapedTable = `"${tableName}"`;
    const triggerName = `pgfire_trg_${tableName}`;

    // 使用 TRANSACTION 或順序執行
    await this.client.query(`DROP TRIGGER IF EXISTS "${triggerName}" ON ${escapedTable};`);
    await this.client.query(`
      CREATE TRIGGER "${triggerName}"
      AFTER INSERT OR UPDATE OR DELETE ON ${escapedTable}
      FOR EACH ROW EXECUTE FUNCTION pgfire_notify_trigger();
    `);
  }

  /**
   * 為指定的資料表停用 PgFire 異動通知觸發器。
   */
  async disableTriggerForTable(tableName: string): Promise<void> {
    validateTableName(tableName);
    const escapedTable = `"${tableName}"`;
    const triggerName = `pgfire_trg_${tableName}`;

    await this.client.query(`DROP TRIGGER IF EXISTS "${triggerName}" ON ${escapedTable};`);
  }
}
