import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { AppError } from '@/common/errors.js';
import { ok } from '@/common/http-response.js';
import type { AppEnv } from '@/config/env.js';
import type { Database } from '@/infrastructure/database.js';
import { requireAdmin } from '@/modules/admin/admin-auth-routes.js';

export type QueryOp = 'eq' | 'like' | 'ge' | 'le';

export type AdminResource = {
  path: string;
  table: string;
  idField?: string;
  orderBy?: string[];
  query?: Record<string, QueryOp>;
  searchLike?: string[];
  searchEq?: string[];
  hidden?: string[];
  writable?: string[];
  createTableSql?: string;
  beforeWrite?: (body: Record<string, unknown>, mode: 'add' | 'edit') => void;
  actions?: Array<'page' | 'add' | 'edit' | 'delete' | 'detail'>;
};

type Column = {
  name: string;
  camel: string;
  dataType: string;
  tinyint1: boolean;
  numeric: boolean;
  temporal: boolean;
};

const columnsCache = new Map<string, Column[]>();
const ensuredTables = new Set<string>();
let idSequence = 0;

const RESERVED_QUERY = new Set(['current', 'size', 'sortField', 'sortOrder', 'searchKey', '_']);

export function nextAdminId(): string {
  idSequence = (idSequence + 1) % 4096;
  return ((BigInt(Date.now()) << 12n) | BigInt(idSequence)).toString();
}

export function adminPage<T>(records: T[], total: number, current: number, size: number) {
  return {
    records,
    total,
    size,
    current,
    pages: size > 0 ? Math.ceil(total / size) : 0,
  };
}

export function pageArgs(query: Record<string, unknown>, maxSize = 1000) {
  const current = positiveInt(query.current, 1);
  const size = Math.min(positiveInt(query.size, 10), maxSize);
  return { current, size, offset: (current - 1) * size };
}

export function queryText(value: unknown): string {
  if (Array.isArray(value)) return queryText(value[0]);
  if (value == null) return '';
  return String(value).trim();
}

function positiveInt(value: unknown, fallback: number) {
  const parsed = Number(queryText(value));
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

function ident(name: string): RawBuilder<unknown> {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new AppError(500, '字段名不合法');
  return sql.raw(`\`${name}\``);
}

function toCamel(column: string) {
  return column.toLowerCase().replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

async function loadColumns(db: Kysely<Database>, table: string): Promise<Column[]> {
  const cached = columnsCache.get(table);
  if (cached) return cached;
  const result = await sql<{
    COLUMN_NAME: string;
    DATA_TYPE: string;
    COLUMN_TYPE: string;
  }>`
    SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table}
    ORDER BY ORDINAL_POSITION
  `.execute(db);
  if (result.rows.length === 0) throw new AppError(500, `数据表 ${table} 不存在`);
  const columns = result.rows.map((row) => {
    const dataType = row.DATA_TYPE.toLowerCase();
    return {
      name: row.COLUMN_NAME,
      camel: toCamel(row.COLUMN_NAME),
      dataType,
      tinyint1: row.COLUMN_TYPE.toLowerCase().startsWith('tinyint(1)'),
      numeric: ['int', 'bigint', 'decimal', 'float', 'double', 'tinyint', 'smallint', 'mediumint'].includes(dataType),
      temporal: dataType.includes('date') || dataType.includes('time'),
    };
  });
  columnsCache.set(table, columns);
  return columns;
}

async function ensureTable(db: Kysely<Database>, resource: AdminResource) {
  if (!resource.createTableSql || ensuredTables.has(resource.table)) return;
  await sql.raw(resource.createTableSql).execute(db);
  ensuredTables.add(resource.table);
  columnsCache.delete(resource.table);
}

function findColumn(columns: Column[], camelName: string) {
  return columns.find((column) => column.camel === camelName);
}

function normalizeWrite(column: Column, value: unknown): unknown {
  if (value == null || value === '') return null;
  if (column.tinyint1 && typeof value === 'boolean') return value ? 1 : 0;
  if (column.tinyint1 && (value === 'true' || value === 'false')) return value === 'true' ? 1 : 0;
  if (column.numeric && typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function normalizeRead(column: Column, value: unknown) {
  if (column.tinyint1 && (value === 0 || value === 1)) return value === 1;
  return value;
}

function compareValue(column: Column, value: string): unknown {
  if (column.tinyint1) {
    if (value === 'true' || value === '1') return 1;
    if (value === 'false' || value === '0') return 0;
  }
  if (column.numeric && value !== '' && !Number.isNaN(Number(value))) return Number(value);
  return value;
}

function defaultOp(column: Column): QueryOp {
  if (column.camel.endsWith('Id') || column.camel === 'status' || column.camel === 'infoType') return 'eq';
  if (column.temporal || column.numeric || column.tinyint1) return 'eq';
  return 'like';
}

function filterSql(column: Column, op: QueryOp, value: string): RawBuilder<unknown> {
  const compared = compareValue(column, value);
  if (op === 'like') return sql`${ident(column.name)} LIKE ${`%${value}%`}`;
  if (op === 'ge') return sql`${ident(column.name)} >= ${compared}`;
  if (op === 'le') return sql`${ident(column.name)} <= ${compared}`;
  return sql`${ident(column.name)} = ${compared}`;
}

function rangeColumn(key: string, columns: Column[]) {
  const matched = /^(start|end)([A-Z].*)$/.exec(key);
  if (!matched) return null;
  const suffix = matched[2] ?? '';
  const camelName = suffix.charAt(0).toLowerCase() + suffix.slice(1);
  const column = findColumn(columns, camelName);
  if (!column) return null;
  return { column, op: matched[1] === 'start' ? ('ge' as const) : ('le' as const) };
}

function buildFilters(columns: Column[], query: Record<string, unknown>, resource: AdminResource) {
  const filters: RawBuilder<unknown>[] = [];
  const deleteFlag = findColumn(columns, 'deleteFlag');
  if (deleteFlag) filters.push(sql`${ident(deleteFlag.name)} = 'NOT_DELETE'`);

  const searchKey = queryText(query.searchKey);
  if (searchKey && (resource.searchLike?.length || resource.searchEq?.length)) {
    const parts: RawBuilder<unknown>[] = [];
    for (const name of resource.searchLike ?? []) {
      const column = findColumn(columns, name);
      if (column) parts.push(sql`${ident(column.name)} LIKE ${`%${searchKey}%`}`);
    }
    for (const name of resource.searchEq ?? []) {
      const column = findColumn(columns, name);
      if (column) parts.push(sql`${ident(column.name)} = ${searchKey}`);
    }
    if (parts.length) filters.push(sql`(${sql.join(parts, sql` OR `)})`);
  }

  for (const [key, raw] of Object.entries(query)) {
    if (RESERVED_QUERY.has(key)) continue;
    const value = queryText(raw);
    if (!value) continue;
    const column = findColumn(columns, key);
    if (column) {
      filters.push(filterSql(column, resource.query?.[key] ?? defaultOp(column), value));
      continue;
    }
    const ranged = rangeColumn(key, columns);
    if (ranged) filters.push(filterSql(ranged.column, ranged.op, value));
  }
  return filters;
}

function orderSql(columns: Column[], query: Record<string, unknown>, resource: AdminResource) {
  const sortField = queryText(query.sortField);
  const sortOrder = queryText(query.sortOrder);
  if (sortField && (sortOrder === 'ASCEND' || sortOrder === 'DESCEND')) {
    const column = findColumn(columns, sortField);
    if (column) return sql`ORDER BY ${ident(column.name)} ${sql.raw(sortOrder === 'ASCEND' ? 'ASC' : 'DESC')}`;
  }
  const configured = resource.orderBy ?? ['id asc'];
  const parts = configured.map((item) => {
    const [camelName, direction] = item.split(/\s+/);
    const column = findColumn(columns, camelName ?? '');
    if (!column) return null;
    return sql`${ident(column.name)} ${sql.raw(direction?.toLowerCase() === 'desc' ? 'DESC' : 'ASC')}`;
  }).filter((part): part is RawBuilder<unknown> => part != null);
  if (parts.length === 0) return sql``;
  return sql`ORDER BY ${sql.join(parts, sql`, `)}`;
}

function selectList(columns: Column[], hidden: Set<string>) {
  return sql.join(
    columns
      .filter((column) => !hidden.has(column.camel))
      .map((column) => sql`${ident(column.name)} AS ${ident(column.camel)}`),
    sql`, `,
  );
}

function readRow(columns: Column[], row: Record<string, unknown>) {
  const output: Record<string, unknown> = {};
  for (const column of columns) {
    if (!(column.camel in row)) continue;
    output[column.camel] = normalizeRead(column, row[column.camel]);
  }
  return output;
}

async function insertRow(
  db: Kysely<Database>,
  columns: Column[],
  resource: AdminResource,
  body: Record<string, unknown>,
) {
  const writable = resource.writable ? new Set(resource.writable) : null;
  const idColumn = findColumn(columns, resource.idField ?? 'id');
  if (!idColumn) throw new AppError(500, `${resource.table} 缺少主键`);
  const names: RawBuilder<unknown>[] = [];
  const values: RawBuilder<unknown>[] = [];
  const used = new Set<string>();
  const idValue = queryText(body[idColumn.camel]) || nextAdminId();
  names.push(ident(idColumn.name));
  values.push(sql`${idValue}`);
  used.add(idColumn.name);

  for (const [key, raw] of Object.entries(body)) {
    if (key === idColumn.camel) continue;
    if (writable && !writable.has(key)) continue;
    const column = findColumn(columns, key);
    if (!column || used.has(column.name)) continue;
    names.push(ident(column.name));
    values.push(sql`${normalizeWrite(column, raw)}`);
    used.add(column.name);
  }
  const deleteFlag = findColumn(columns, 'deleteFlag');
  if (deleteFlag && !used.has(deleteFlag.name)) {
    names.push(ident(deleteFlag.name));
    values.push(sql`'NOT_DELETE'`);
    used.add(deleteFlag.name);
  }
  const createTime = findColumn(columns, 'createTime');
  if (createTime && !used.has(createTime.name)) {
    names.push(ident(createTime.name));
    values.push(sql`NOW()`);
  }
  await sql`INSERT INTO ${ident(resource.table)} (${sql.join(names, sql`, `)}) VALUES (${sql.join(values, sql`, `)})`.execute(db);
}

async function updateRow(
  db: Kysely<Database>,
  columns: Column[],
  resource: AdminResource,
  body: Record<string, unknown>,
) {
  const idColumn = findColumn(columns, resource.idField ?? 'id');
  if (!idColumn) throw new AppError(500, `${resource.table} 缺少主键`);
  const id = queryText(body[idColumn.camel]);
  if (!id) throw new AppError(400, '缺少主键');
  const writable = resource.writable ? new Set(resource.writable) : null;
  const assignments: RawBuilder<unknown>[] = [];
  for (const [key, raw] of Object.entries(body)) {
    if (key === idColumn.camel) continue;
    if (writable && !writable.has(key)) continue;
    const column = findColumn(columns, key);
    if (!column) continue;
    assignments.push(sql`${ident(column.name)} = ${normalizeWrite(column, raw)}`);
  }
  const updateTime = findColumn(columns, 'updateTime');
  if (updateTime) assignments.push(sql`${ident(updateTime.name)} = NOW()`);
  if (assignments.length === 0) return;
  const deleteFlag = findColumn(columns, 'deleteFlag');
  await sql`
    UPDATE ${ident(resource.table)}
    SET ${sql.join(assignments, sql`, `)}
    WHERE ${ident(idColumn.name)} = ${id}
    ${deleteFlag ? sql`AND ${ident(deleteFlag.name)} = 'NOT_DELETE'` : sql``}
  `.execute(db);
}

export function registerAdminResources(
  app: FastifyInstance,
  env: AppEnv,
  db: Kysely<Database>,
  resources: AdminResource[],
) {
  const adminGuard = requireAdmin(env, db);
  for (const resource of resources) {
    const actions = new Set(resource.actions ?? ['page', 'add', 'edit', 'delete', 'detail']);
    const hidden = new Set(resource.hidden ?? []);
    const prepare = async () => {
      await ensureTable(db, resource);
      return loadColumns(db, resource.table);
    };

    if (actions.has('page')) {
      app.get<{ Querystring: Record<string, unknown> }>(
        `${resource.path}/page`,
        { preHandler: adminGuard },
        async (request) => {
          const columns = await prepare();
          const { current, size, offset } = pageArgs(request.query);
          const filters = buildFilters(columns, request.query, resource);
          const where = filters.length ? sql`WHERE ${sql.join(filters, sql` AND `)}` : sql``;
          const count = await sql<{ total: number | string }>`
            SELECT COUNT(*) AS total FROM ${ident(resource.table)} ${where}
          `.execute(db);
          const rows = await sql<Record<string, unknown>>`
            SELECT ${selectList(columns, hidden)}
            FROM ${ident(resource.table)}
            ${where}
            ${orderSql(columns, request.query, resource)}
            LIMIT ${sql.raw(String(size))} OFFSET ${sql.raw(String(offset))}
          `.execute(db);
          return ok(adminPage(rows.rows.map((row) => readRow(columns, row)), Number(count.rows[0]?.total ?? 0), current, size));
        },
      );
    }

    if (actions.has('detail')) {
      app.get<{ Querystring: Record<string, unknown> }>(
        `${resource.path}/detail`,
        { preHandler: adminGuard },
        async (request) => {
          const columns = await prepare();
          const idColumn = findColumn(columns, resource.idField ?? 'id');
          if (!idColumn) throw new AppError(500, `${resource.table} 缺少主键`);
          const id = queryText(request.query[idColumn.camel] ?? request.query.id);
          if (!id) throw new AppError(400, '缺少主键');
          const deleteFlag = findColumn(columns, 'deleteFlag');
          const row = await sql<Record<string, unknown>>`
            SELECT ${selectList(columns, hidden)}
            FROM ${ident(resource.table)}
            WHERE ${ident(idColumn.name)} = ${id}
            ${deleteFlag ? sql`AND ${ident(deleteFlag.name)} = 'NOT_DELETE'` : sql``}
            LIMIT 1
          `.execute(db);
          if (!row.rows[0]) throw new AppError(404, '记录不存在');
          return ok(readRow(columns, row.rows[0]));
        },
      );
    }

    if (actions.has('add')) {
      app.post<{ Body: Record<string, unknown> }>(
        `${resource.path}/add`,
        { preHandler: adminGuard },
        async (request) => {
          const columns = await prepare();
          const body = request.body ?? {};
          resource.beforeWrite?.(body, 'add');
          await insertRow(db, columns, resource, body);
          return ok(null);
        },
      );
    }

    if (actions.has('edit')) {
      app.post<{ Body: Record<string, unknown> }>(
        `${resource.path}/edit`,
        { preHandler: adminGuard },
        async (request) => {
          const columns = await prepare();
          const body = request.body ?? {};
          resource.beforeWrite?.(body, 'edit');
          await updateRow(db, columns, resource, body);
          return ok(null);
        },
      );
    }

    if (actions.has('delete')) {
      app.post<{ Body: unknown }>(
        `${resource.path}/delete`,
        { preHandler: adminGuard },
        async (request) => {
          const columns = await prepare();
          const idColumn = findColumn(columns, resource.idField ?? 'id');
          if (!idColumn) throw new AppError(500, `${resource.table} 缺少主键`);
          const ids = idsFrom(request.body, idColumn.camel);
          if (ids.length === 0) throw new AppError(400, '集合不能为空');
          const deleteFlag = findColumn(columns, 'deleteFlag');
          if (deleteFlag) {
            await sql`
              UPDATE ${ident(resource.table)}
              SET ${ident(deleteFlag.name)} = 'DELETED'
              WHERE ${ident(idColumn.name)} IN (${sql.join(ids.map((id) => sql`${id}`))})
            `.execute(db);
          } else {
            await sql`
              DELETE FROM ${ident(resource.table)}
              WHERE ${ident(idColumn.name)} IN (${sql.join(ids.map((id) => sql`${id}`))})
            `.execute(db);
          }
          return ok(null);
        },
      );
    }
  }
}

export function idsFrom(body: unknown, idField: string) {
  const list = Array.isArray(body) ? body : body && typeof body === 'object' ? [body] : [];
  return list
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const record = item as Record<string, unknown>;
      return queryText(record[idField] ?? record.id);
    })
    .filter(Boolean);
}

export async function readUpload(request: FastifyRequest, imageOnly: boolean) {
  const part = await request.file();
  if (!part) throw new AppError(400, '上传图片不能为空');
  const body = await part.toBuffer();
  if (body.byteLength === 0) throw new AppError(400, '上传图片不能为空');
  if (body.byteLength > 5 * 1024 * 1024) throw new AppError(400, '图片不能超过 5MB');
  if (imageOnly && part.mimetype && !part.mimetype.startsWith('image/')) {
    throw new AppError(400, '只能上传图片');
  }
  return { body, mimetype: part.mimetype, filename: part.filename };
}
