import { QueryRequest, WhereCondition, OrderByCondition } from './types.js';

export interface CompiledQuery {
  text: string;
  values: any[];
}

const TABLE_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const FIELD_PATH_REGEX = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;

function validateTableName(table: string): void {
  if (!TABLE_NAME_REGEX.test(table)) {
    throw new Error(`Invalid table name: "${table}"`);
  }
}

function validateFieldPath(field: string): void {
  if (!FIELD_PATH_REGEX.test(field)) {
    throw new Error(`Invalid field path: "${field}"`);
  }
}

export function getFieldPathAsText(field: string): string {
  validateFieldPath(field);
  const parts = field.split('.');
  return `data #>> '{${parts.join(',')}}'`;
}

export function getFieldPathAsJsonb(field: string): string {
  validateFieldPath(field);
  const parts = field.split('.');
  return `data #> '{${parts.join(',')}}'`;
}

export function compileQuery(request: QueryRequest): CompiledQuery {
  validateTableName(request.table);
  const escapedTable = `"${request.table}"`;

  const values: any[] = [];
  let paramCount = 1;
  const nextParam = () => `$${paramCount++}`;

  const wheres: string[] = [];

  for (const condition of request.wheres) {
    const { field, op, value } = condition;
    
    switch (op) {
      case '==': {
        const sqlField = getFieldPathAsText(field);
        wheres.push(`${sqlField} = ${nextParam()}`);
        values.push(value === null ? null : String(value));
        break;
      }
      case '!=': {
        const sqlField = getFieldPathAsText(field);
        wheres.push(`${sqlField} != ${nextParam()}`);
        values.push(value === null ? null : String(value));
        break;
      }
      case '<':
      case '<=':
      case '>':
      case '>=': {
        const sqlField = getFieldPathAsText(field);
        wheres.push(`(${sqlField})::numeric ${op} ${nextParam()}`);
        values.push(Number(value));
        break;
      }
      case 'in': {
        if (!Array.isArray(value)) {
          throw new Error(`Value for "in" operator must be an array: ${value}`);
        }
        const sqlField = getFieldPathAsText(field);
        wheres.push(`${sqlField} = ANY(${nextParam()}::text[])`);
        values.push(value.map(val => val === null ? null : String(val)));
        break;
      }
      case 'not-in': {
        if (!Array.isArray(value)) {
          throw new Error(`Value for "not-in" operator must be an array: ${value}`);
        }
        const sqlField = getFieldPathAsText(field);
        wheres.push(`${sqlField} != ALL(${nextParam()}::text[])`);
        values.push(value.map(val => val === null ? null : String(val)));
        break;
      }
      case 'array-contains': {
        const sqlField = getFieldPathAsJsonb(field);
        wheres.push(`${sqlField} @> ${nextParam()}::jsonb`);
        values.push(JSON.stringify(value));
        break;
      }
      case 'array-contains-any': {
        if (!Array.isArray(value)) {
          throw new Error(`Value for "array-contains-any" operator must be an array: ${value}`);
        }
        const sqlField = getFieldPathAsJsonb(field);
        wheres.push(`${sqlField} ?| ${nextParam()}::text[]`);
        values.push(value.map(val => String(val)));
        break;
      }
      default: {
        const _exhaustiveCheck: never = op;
        throw new Error(`Unsupported operator: ${op}`);
      }
    }
  }

  let sql = `SELECT id, data, _created_at, _updated_at FROM ${escapedTable}`;

  if (wheres.length > 0) {
    sql += ` WHERE ${wheres.join(' AND ')}`;
  }

  if (request.orderBys && request.orderBys.length > 0) {
    const orderBysSql = request.orderBys.map((orderBy) => {
      const isNumeric = request.wheres.some(
        (w) => w.field === orderBy.field && ['<', '<=', '>', '>='].includes(w.op)
      );
      const sqlField = isNumeric
        ? `(${getFieldPathAsText(orderBy.field)})::numeric`
        : getFieldPathAsText(orderBy.field);
      const dir = orderBy.direction.toUpperCase();
      return `${sqlField} ${dir}`;
    });
    sql += ` ORDER BY ${orderBysSql.join(', ')}`;
  }

  if (request.limit !== undefined) {
    sql += ` LIMIT ${nextParam()}`;
    values.push(request.limit);
  }

  return {
    text: sql,
    values,
  };
}
