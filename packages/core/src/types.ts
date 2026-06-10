export type WhereFilterOp =
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'in'
  | 'not-in'
  | 'array-contains'
  | 'array-contains-any';

export type OrderByDirection = 'asc' | 'desc';

export interface DocumentData {
  [key: string]: any;
}

export interface WhereCondition {
  field: string;
  op: WhereFilterOp;
  value: any;
}

export interface OrderByCondition {
  field: string;
  direction: OrderByDirection;
}

export interface QueryRequest {
  table: string;
  wheres: WhereCondition[];
  orderBys: OrderByCondition[];
  limit?: number;
}

export type FieldValueType =
  | 'increment'
  | 'arrayUnion'
  | 'arrayRemove'
  | 'serverTimestamp'
  | 'deleteField';

export class FieldValue {
  constructor(
    public readonly type: FieldValueType,
    public readonly operand?: any
  ) {}

  toJSON() {
    return {
      __pgfire_sentinel__: this.type,
      operand: this.operand,
    };
  }
}

export function reviveFieldValues(obj: any): any {
  if (obj === null || obj === undefined) return obj;

  if (Array.isArray(obj)) {
    return obj.map(reviveFieldValues);
  }

  if (typeof obj === 'object') {
    if (obj.__pgfire_sentinel__ !== undefined) {
      return new FieldValue(obj.__pgfire_sentinel__, reviveFieldValues(obj.operand));
    }
    const revived: Record<string, any> = {};
    for (const key of Object.keys(obj)) {
      revived[key] = reviveFieldValues(obj[key]);
    }
    return revived;
  }

  return obj;
}

export function increment(value: number): FieldValue {
  return new FieldValue('increment', value);
}

export function arrayUnion(...values: any[]): FieldValue {
  return new FieldValue('arrayUnion', values);
}

export function arrayRemove(...values: any[]): FieldValue {
  return new FieldValue('arrayRemove', values);
}

export function serverTimestamp(): FieldValue {
  return new FieldValue('serverTimestamp');
}

export function deleteField(): FieldValue {
  return new FieldValue('deleteField');
}
