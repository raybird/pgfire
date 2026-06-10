# Real-time Subscriptions

## How It Works

PgFire uses PostgreSQL's native `LISTEN/NOTIFY` mechanism for real-time change notification:

1. A PostgreSQL trigger function `pgfire_notify_trigger()` is installed on each managed table
2. On INSERT, UPDATE, or DELETE, the trigger fires and calls `pg_notify('pgfire_changes', payload)`
3. A dedicated Node.js client connection listens on the `pgfire_changes` channel
4. Incoming notifications are parsed and routed to matching subscriptions

## Trigger Function

```sql
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
```

## Notification Payload

```json
{
  "table": "users",
  "id": "abc-123",
  "op": "UPDATE",
  "data": { "name": "Alice", "age": 31 },
  "old_data": { "name": "Alice", "age": 30 },
  "txid": 12345,
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

## Notification Filtering

### Embedded Mode

When a NOTIFY arrives, the embedded engine:
1. Re-executes the full query against the database
2. Diffs the new result set against the previous snapshot
3. Computes `docChanges()` (added, modified, removed)

### Server Mode (SSE)

When a NOTIFY arrives, the server:
1. Finds all subscriptions for the affected table
2. For each subscription, runs a targeted SQL recheck with the subscription's WHERE conditions
3. Sends a filtered SSE event only to matching subscriptions

## SSE Protocol

### Connection

```
Client → GET /pgfire/sse?token=JWT
Server → event: connected
         data: {"clientId":"c_abc123"}
```

### Subscription

```
Client → POST /pgfire/subscribe
         { "table": "users", "query": { "wheres": [...], "orderBys": [...], "limit": 10 } }
Server → 200 { "subscriptionId": "sub_001" }
```

### Change Event

```
Server → event: change
         data: {"subscriptionId":"sub_001","payload":{...}}
```

### Reconnection

```
Client → (reconnect) GET /pgfire/sse?token=JWT&clientId=c_abc123
Server → event: connected
         data: {"clientId":"c_abc123","reconnected":true}
Client → POST /pgfire/resubscribe
         { "subscriptions": [{"table":"users","query":{...}}] }
Server → 200 { "results": [{"subscriptionId":"sub_002"}] }
```

## Reconnection Strategy

- Exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s (max)
- Random jitter (±25%) to avoid thundering herd
- On reconnect, all active subscriptions are re-registered
- After reconnect, the client re-fetches the full query to ensure consistency (NOTIFY delivery is best-effort)