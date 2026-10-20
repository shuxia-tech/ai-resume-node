import { randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import { sql } from 'kysely';
import { saveClientToken } from '@/auth/request-user.js';
import { authRedis } from '@/auth/request-user.js';
import type { AppEnv } from '@/config/env.js';
import {
  asDate,
  campus,
  campusAdminToken,
  campusLoginId,
  cellNumber,
  cellText,
  clientIp,
  createCampusCsrf,
  decryptAdminPassword,
  executeAffected,
  flag,
  hasCampusPermission,
  insertRow,
  kickCampusAdmin,
  loadCampusAdminSession,
  newId,
  optionalText,
  queryCount,
  queryOne,
  queryRows,
  randomToken,
  removeCampusCsrf,
  requireBound,
  saveCampusAdminSession,
  sha256,
  stringList,
  text,
  withLock,
  type CampusAdminSession,
  type CampusDb,
  type Row,
} from '@/modules/campus-circle/campus-support.js';

const STAFF_TYPES = new Set(['REVIEWER', 'OPERATOR']);
const RESOURCE_TYPES = new Set(['CATALOG', 'MENU', 'ACTION']);
const ACCOUNT_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{3,31}$/;

function sessionOf(user: Row, permissions: string[], routes: string[]): CampusAdminSession {
  return {
    id: cellText(user, 'id') ?? '',
    account: cellText(user, 'account') ?? '',
    name: cellText(user, 'name') ?? '',
    accountType: cellText(user, 'account_type') ?? '',
    permissions,
    routes,
  };
}

async function resourceIds(db: CampusDb, userId: string) {
  const rows = await queryRows(
    db,
    sql`SELECT resource_id FROM sc_campus_admin_user_resource WHERE user_id = ${userId}`,
  );
  return rows.map((row) => cellText(row, 'resource_id') ?? '').filter(Boolean);
}

async function permissionCodes(db: CampusDb, userId: string) {
  const ids = await resourceIds(db, userId);
  if (ids.length === 0) return [];
  const rows = await queryRows(
    db,
    sql`SELECT permission_code FROM sc_campus_admin_resource
        WHERE delete_flag = 'NOT_DELETE' AND enabled_flag = 1 AND permission_code IS NOT NULL
          AND id IN (${sql.join(ids.map((id) => sql`${id}`))})`,
  );
  return [...new Set(rows.map((row) => cellText(row, 'permission_code') ?? '').filter(Boolean))];
}

async function routePaths(db: CampusDb, userId: string) {
  const ids = await resourceIds(db, userId);
  if (ids.length === 0) return [];
  const rows = await queryRows(
    db,
    sql`SELECT route_path FROM sc_campus_admin_resource
        WHERE delete_flag = 'NOT_DELETE' AND enabled_flag = 1 AND route_path IS NOT NULL
          AND id IN (${sql.join(ids.map((id) => sql`${id}`))})`,
  );
  return [...new Set(rows.map((row) => cellText(row, 'route_path') ?? '').filter(Boolean))];
}

async function toSession(db: CampusDb, user: Row): Promise<CampusAdminSession> {
  const admin = cellText(user, 'account_type') === 'ADMIN';
  return sessionOf(
    user,
    admin ? ['*'] : await permissionCodes(db, cellText(user, 'id') ?? ''),
    admin ? ['*'] : await routePaths(db, cellText(user, 'id') ?? ''),
  );
}

export function sessionResult(session: CampusAdminSession) {
  return {
    id: session.id,
    avatar: null,
    account: session.account,
    name: session.name,
    nickname: null,
    buttonCodes: [] as string[],
    permissions: session.permissions,
    roles: [session.accountType],
    routes: session.routes,
  };
}

async function recordLogin(db: CampusDb, request: FastifyRequest, userId: string | null, account: string, result: string, reason: string | null) {
  const agent = text(request.headers['user-agent']).slice(0, 500);
  await insertRow(db, 'sc_campus_admin_login_log', {
    id: newId(),
    user_id: userId,
    account: account.slice(0, 64),
    result,
    failure_reason: reason,
    ip_hash: sha256(clientIp(request)),
    user_agent: agent || null,
    login_time: new Date(),
  });
}

export async function campusLogin(db: CampusDb, env: AppEnv, request: FastifyRequest, body: Record<string, unknown>) {
  const account = text(body.account);
  const password = text(body.password);
  requireBound(account, '账号不能为空', 64, '账号不能超过64字');
  if (!password) throw campus(500, '密码不能为空');
  const user = await queryOne(
    db,
    sql`SELECT * FROM sc_campus_admin_user WHERE delete_flag = 'NOT_DELETE' AND account = ${account} LIMIT 1`,
  );
  if (!user) {
    await recordLogin(db, request, null, account, 'FAILED', 'CREDENTIAL');
    throw campus(401, '账号或密码错误');
  }
  const userId = cellText(user, 'id') ?? '';
  const now = new Date();
  if (cellText(user, 'status') !== 'ENABLED') {
    await recordLogin(db, request, userId, account, 'FAILED', 'DISABLED');
    throw campus(403, '账号已停用');
  }
  const lockedUntil = asDate(user.locked_until);
  if (lockedUntil && lockedUntil.getTime() > now.getTime()) {
    await recordLogin(db, request, userId, account, 'FAILED', 'LOCKED');
    throw campus(423, '登录失败次数过多，请稍后再试');
  }
  const rawPassword = decryptAdminPassword(password, env);
  if (!bcrypt.compareSync(rawPassword, cellText(user, 'password_hash') ?? '')) {
    const lockExpired = lockedUntil != null && lockedUntil.getTime() <= now.getTime();
    const failedCount = lockExpired || user.failed_login_count == null ? 1 : cellNumber(user, 'failed_login_count') + 1;
    const lock = failedCount >= 5 ? new Date(now.getTime() + 15 * 60 * 1000) : null;
    await sql`UPDATE sc_campus_admin_user
              SET failed_login_count = ${failedCount}, locked_until = ${lock}, update_time = ${now}
              WHERE id = ${userId}`.execute(db);
    await recordLogin(db, request, userId, account, 'FAILED', failedCount >= 5 ? 'LOCKED' : 'CREDENTIAL');
    throw campus(401, '账号或密码错误');
  }
  await sql`UPDATE sc_campus_admin_user
            SET failed_login_count = 0, locked_until = NULL, last_login_time = ${now},
                last_login_ip_hash = ${sha256(clientIp(request))}, update_time = ${now}
            WHERE id = ${userId}`.execute(db);
  const session = await toSession(db, user);
  const token = randomBytes(16).toString('hex');
  await saveCampusAdminSession(env, token, session);
  await recordLogin(db, request, userId, account, 'SUCCESS', null);
  return { token, session };
}

export async function currentCampusSession(db: CampusDb, env: AppEnv, request: FastifyRequest) {
  const token = campusAdminToken(request);
  const session = await loadCampusAdminSession(env, token);
  if (session) return session;
  const userId = await campusLoginId(env, token);
  if (!userId) throw campus(401, '登录状态已失效');
  const user = await queryOne(db, sql`SELECT * FROM sc_campus_admin_user WHERE delete_flag = 'NOT_DELETE' AND id = ${userId} LIMIT 1`);
  if (!user || cellText(user, 'status') !== 'ENABLED') throw campus(401, '登录状态已失效');
  const rebuilt = await toSession(db, user);
  await saveCampusAdminSession(env, token, rebuilt);
  return rebuilt;
}

export async function requireCampusAdmin(
  db: CampusDb,
  env: AppEnv,
  request: FastifyRequest,
  permission?: string,
  role?: string,
) {
  const session = await currentCampusSession(db, env, request);
  if (role && session.accountType !== role) throw campus(403, '无此角色');
  if (permission && !hasCampusPermission(session, permission)) throw campus(403, `无此权限：${permission}`);
  return session;
}

async function userResult(db: CampusDb, user: Row) {
  const admin = cellText(user, 'account_type') === 'ADMIN';
  return {
    id: cellText(user, 'id'),
    account: cellText(user, 'account'),
    name: cellText(user, 'name'),
    accountType: cellText(user, 'account_type'),
    enabled: cellText(user, 'status') === 'ENABLED',
    lockedUntil: asDate(user.locked_until),
    lastLoginTime: asDate(user.last_login_time),
    createTime: asDate(user.create_time),
    resourceIds: admin ? [] : await resourceIds(db, cellText(user, 'id') ?? ''),
  };
}

export async function staffList(db: CampusDb) {
  const rows = await queryRows(
    db,
    sql`SELECT * FROM sc_campus_admin_user WHERE delete_flag = 'NOT_DELETE' ORDER BY account_type ASC, create_time ASC`,
  );
  return Promise.all(rows.map((row) => userResult(db, row)));
}

export async function saveStaff(
  db: CampusDb,
  env: AppEnv,
  request: FastifyRequest,
  operator: CampusAdminSession,
  body: Record<string, unknown>,
) {
  const id = text(body.id);
  const account = text(body.account);
  const name = text(body.name);
  const accountType = text(body.accountType);
  const password = text(body.password);
  const enabled = body.enabled === true || body.enabled === 'true' || body.enabled === 1;
  const selectedIds = stringList(body.resourceIds);
  requireBound(account, '账号不能为空', 32, '账号不能超过32个字符');
  requireBound(name, '姓名不能为空', 64, '姓名不能超过64个字符');
  if (!accountType) throw campus(500, '账号类型不能为空');
  if (body.enabled == null) throw campus(500, '状态不能为空');
  if (!Array.isArray(body.resourceIds)) throw campus(500, '授权资源不能为空');
  if (!ACCOUNT_PATTERN.test(account)) {
    throw campus(500, '账号须以字母开头，只能包含字母、数字、点、横线或下划线，长度4至32位');
  }
  const now = new Date();
  const creating = !id;
  let userId = id;
  if (creating) {
    if (!STAFF_TYPES.has(accountType)) throw campus(500, '只能创建审核员或运营人员');
    if (!password) throw campus(500, '新建账号必须设置初始密码');
    userId = newId();
  } else {
    const existing = await queryOne(db, sql`SELECT * FROM sc_campus_admin_user WHERE delete_flag = 'NOT_DELETE' AND id = ${id} LIMIT 1`);
    if (!existing) throw campus(500, '管理账号不存在');
    if (cellText(existing, 'account_type') === 'ADMIN') {
      if (cellText(existing, 'account') !== account) throw campus(500, '内置管理员的登录账号不可修改');
      if (accountType !== 'ADMIN' || !enabled) throw campus(500, '内置管理员不能修改账号类型或停用');
    } else if (!STAFF_TYPES.has(accountType)) {
      throw campus(500, '账号类型不正确');
    }
  }
  const duplicate = await queryCount(
    db,
    creating
      ? sql`SELECT COUNT(*) AS total FROM sc_campus_admin_user WHERE delete_flag = 'NOT_DELETE' AND account = ${account}`
      : sql`SELECT COUNT(*) AS total FROM sc_campus_admin_user WHERE delete_flag = 'NOT_DELETE' AND account = ${account} AND id <> ${userId}`,
  );
  if (duplicate > 0) throw campus(500, '账号已存在');
  let passwordHash: string | null = null;
  if (password) {
    const raw = decryptAdminPassword(password, env);
    if (raw.length < 10 || raw.length > 72) throw campus(500, '密码长度须为10至72位');
    passwordHash = bcrypt.hashSync(raw, 12);
  }
  if (creating) {
    await insertRow(db, 'sc_campus_admin_user', {
      id: userId,
      account,
      password_hash: passwordHash,
      name,
      account_type: accountType,
      status: enabled ? 'ENABLED' : 'DISABLED',
      failed_login_count: 0,
      locked_until: null,
      last_login_time: null,
      last_login_ip_hash: null,
      version: 0,
      delete_flag: 'NOT_DELETE',
      create_time: now,
      create_user: operator.id,
      update_time: null,
      update_user: null,
    });
  } else {
    await sql`UPDATE sc_campus_admin_user
              SET account = ${account}, name = ${name}, account_type = ${accountType},
                  status = ${enabled ? 'ENABLED' : 'DISABLED'},
                  password_hash = COALESCE(${passwordHash}, password_hash),
                  update_time = ${now}, update_user = ${operator.id}
              WHERE id = ${userId}`.execute(db);
  }
  if (accountType !== 'ADMIN') await grantResources(db, userId, selectedIds, operator.id);
  const saved = await queryOne(db, sql`SELECT * FROM sc_campus_admin_user WHERE id = ${userId} LIMIT 1`);
  if (userId === operator.id && saved) {
    await saveCampusAdminSession(env, campusAdminToken(request), await toSession(db, saved));
  } else {
    await kickCampusAdmin(env, userId);
  }
  return userId;
}

async function grantResources(db: CampusDb, userId: string, selectedIds: string[], operatorId: string) {
  const resources = await queryRows(
    db,
    sql`SELECT id, parent_id FROM sc_campus_admin_resource WHERE delete_flag = 'NOT_DELETE' AND enabled_flag = 1`,
  );
  const byId = new Map(resources.map((row) => [cellText(row, 'id') ?? '', row]));
  const granted = new Set<string>();
  for (const selectedId of selectedIds) {
    let current = byId.get(selectedId);
    if (!current) throw campus(500, '授权资源不存在或已停用');
    while (current) {
      const currentId = cellText(current, 'id') ?? '';
      if (!currentId || granted.has(currentId)) break;
      granted.add(currentId);
      current = byId.get(cellText(current, 'parent_id') ?? '');
    }
  }
  await sql`DELETE FROM sc_campus_admin_user_resource WHERE user_id = ${userId}`.execute(db);
  const now = new Date();
  for (const resourceId of granted) {
    await insertRow(db, 'sc_campus_admin_user_resource', {
      id: newId(),
      user_id: userId,
      resource_id: resourceId,
      create_time: now,
      create_user: operatorId,
    });
  }
}

type ResourceNode = {
  id: string | null;
  parentId: string | null;
  name: string | null;
  resourceType: string | null;
  routePath: string | null;
  permissionCode: string | null;
  sortCode: number;
  enabled: boolean;
  builtIn: boolean;
  children: ResourceNode[];
};

function resourceNode(row: Row): ResourceNode {
  return {
    id: cellText(row, 'id'),
    parentId: cellText(row, 'parent_id'),
    name: cellText(row, 'name'),
    resourceType: cellText(row, 'resource_type'),
    routePath: cellText(row, 'route_path'),
    permissionCode: cellText(row, 'permission_code'),
    sortCode: cellNumber(row, 'sort_code'),
    enabled: flag(row.enabled_flag),
    builtIn: flag(row.built_in_flag),
    children: [],
  };
}

export async function resourceTree(db: CampusDb) {
  const rows = await queryRows(
    db,
    sql`SELECT * FROM sc_campus_admin_resource WHERE delete_flag = 'NOT_DELETE' ORDER BY sort_code ASC, id ASC`,
  );
  const nodes = new Map(rows.map((row) => [cellText(row, 'id') ?? '', resourceNode(row)]));
  const roots: ResourceNode[] = [];
  for (const row of rows) {
    const node = nodes.get(cellText(row, 'id') ?? '');
    const parent = nodes.get(cellText(row, 'parent_id') ?? '');
    if (!node) continue;
    if (!parent) roots.push(node);
    else parent.children.push(node);
  }
  const sortTree = (items: ReturnType<typeof resourceNode>[]) => {
    items.sort((left, right) => left.sortCode - right.sortCode || String(left.id).localeCompare(String(right.id)));
    items.forEach((item) => sortTree(item.children));
  };
  sortTree(roots);
  return roots;
}

async function queryResource(db: CampusDb, id: string) {
  const row = await queryOne(db, sql`SELECT * FROM sc_campus_admin_resource WHERE delete_flag = 'NOT_DELETE' AND id = ${id} LIMIT 1`);
  if (!row) throw campus(500, '资源不存在');
  return row;
}

export async function saveResource(db: CampusDb, env: AppEnv, operatorId: string, body: Record<string, unknown>) {
  const id = text(body.id);
  const name = text(body.name);
  const resourceType = text(body.resourceType);
  const routePath = optionalText(body.routePath);
  const permissionCode = optionalText(body.permissionCode);
  const sortCode = Number(body.sortCode);
  const enabled = body.enabled === true || body.enabled === 'true' || body.enabled === 1;
  requireBound(name, '资源名称不能为空', 64, '资源名称不能超过64个字符');
  if (!resourceType) throw campus(500, '资源类型不能为空');
  if (!RESOURCE_TYPES.has(resourceType)) throw campus(500, '资源类型不正确');
  limitOptional(routePath, 255, '路由地址不能超过255个字符');
  limitOptional(permissionCode, 255, '权限码不能超过255个字符');
  if (!Number.isInteger(sortCode) || sortCode < 0) throw campus(500, '排序不能小于0');
  if (sortCode > 999999) throw campus(500, '排序不能大于999999');
  if (body.enabled == null) throw campus(500, '状态不能为空');
  const parentId = normalizeParent(text(body.parentId));
  if (parentId) {
    if (parentId === id) throw campus(500, '资源不能选择自己作为上级');
    const parent = await queryResource(db, parentId);
    if (cellText(parent, 'resource_type') === 'ACTION') throw campus(500, '操作节点不能作为上级资源');
    await ensureNoCycle(db, id, parentId);
  }
  const menuPath = resourceType === 'MENU' ? routePath : null;
  const actionCode = resourceType === 'ACTION' ? permissionCode : null;
  if (resourceType === 'MENU' && !menuPath) throw campus(500, '菜单必须配置路由地址');
  if (resourceType === 'ACTION' && !actionCode) throw campus(500, '操作必须配置权限码');
  if (menuPath && !menuPath.startsWith('/')) throw campus(500, '路由地址必须以 / 开头');
  if (actionCode && !actionCode.startsWith('/app/campus-circle/')) throw campus(500, '权限码必须以 /app/campus-circle/ 开头');
  if (resourceType === 'ACTION' && id) {
    const children = await queryCount(
      db,
      sql`SELECT COUNT(*) AS total FROM sc_campus_admin_resource WHERE delete_flag = 'NOT_DELETE' AND parent_id = ${id}`,
    );
    if (children > 0) throw campus(500, '存在下级资源的节点不能改为操作类型');
  }
  await assertUnique(db, 'route_path', menuPath, id, '路由地址已存在');
  await assertUnique(db, 'permission_code', actionCode, id, '权限码已存在');
  const now = new Date();
  let resourceId = id;
  if (!id) {
    resourceId = newId();
    await insertRow(db, 'sc_campus_admin_resource', {
      id: resourceId,
      parent_id: parentId,
      name,
      resource_type: resourceType,
      route_path: menuPath,
      permission_code: actionCode,
      sort_code: sortCode,
      enabled_flag: enabled ? 1 : 0,
      built_in_flag: 0,
      delete_flag: 'NOT_DELETE',
      create_time: now,
      create_user: operatorId,
      update_time: null,
      update_user: null,
    });
  } else {
    const current = await queryResource(db, id);
    if (flag(current.built_in_flag)) {
      if (
        cellText(current, 'resource_type') !== resourceType ||
        cellText(current, 'route_path') !== menuPath ||
        cellText(current, 'permission_code') !== actionCode
      ) {
        throw campus(500, '内置资源的类型、路由和权限码不可修改');
      }
    }
    await sql`UPDATE sc_campus_admin_resource
              SET parent_id = ${parentId}, name = ${name}, resource_type = ${resourceType},
                  route_path = ${menuPath}, permission_code = ${actionCode}, sort_code = ${sortCode},
                  enabled_flag = ${enabled ? 1 : 0}, update_time = ${now}, update_user = ${operatorId}
              WHERE id = ${id}`.execute(db);
    await invalidateResourceUsers(db, env, id);
  }
  return resourceId;
}

function limitOptional(value: string | null, max: number, message: string) {
  if (value && value.length > max) throw campus(500, message);
}

function normalizeParent(value: string) {
  return !value || value === '0' ? null : value;
}

async function assertUnique(db: CampusDb, column: 'route_path' | 'permission_code', value: string | null, id: string, message: string) {
  if (!value) return;
  const count = await queryCount(
    db,
    id
      ? sql`SELECT COUNT(*) AS total FROM sc_campus_admin_resource
            WHERE delete_flag = 'NOT_DELETE' AND ${sql.raw(column)} = ${value} AND id <> ${id}`
      : sql`SELECT COUNT(*) AS total FROM sc_campus_admin_resource
            WHERE delete_flag = 'NOT_DELETE' AND ${sql.raw(column)} = ${value}`,
  );
  if (count > 0) throw campus(500, message);
}

async function ensureNoCycle(db: CampusDb, resourceId: string, parentId: string) {
  if (!resourceId) return;
  const visited = new Set<string>();
  let currentId: string | null = parentId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    if (currentId === resourceId) throw campus(500, '不能将资源移动到自己的下级');
    const current = await queryOne(
      db,
      sql`SELECT parent_id FROM sc_campus_admin_resource WHERE delete_flag = 'NOT_DELETE' AND id = ${currentId} LIMIT 1`,
    );
    currentId = current ? cellText(current, 'parent_id') : null;
  }
}

async function invalidateResourceUsers(db: CampusDb, env: AppEnv, resourceId: string) {
  const rows = await queryRows(
    db,
    sql`SELECT DISTINCT user_id FROM sc_campus_admin_user_resource WHERE resource_id = ${resourceId}`,
  );
  for (const row of rows) {
    const userId = cellText(row, 'user_id');
    if (userId) await kickCampusAdmin(env, userId);
  }
}

export async function deleteResource(db: CampusDb, env: AppEnv, id: string) {
  if (!id) throw campus(500, '资源id不能为空');
  const entity = await queryResource(db, id);
  if (flag(entity.built_in_flag)) throw campus(500, '内置资源不可删除');
  const children = await queryCount(
    db,
    sql`SELECT COUNT(*) AS total FROM sc_campus_admin_resource WHERE delete_flag = 'NOT_DELETE' AND parent_id = ${id}`,
  );
  if (children > 0) throw campus(500, '请先删除下级资源');
  await invalidateResourceUsers(db, env, id);
  await sql`DELETE FROM sc_campus_admin_user_resource WHERE resource_id = ${id}`.execute(db);
  const deleted = await executeAffected(db, sql`DELETE FROM sc_campus_admin_resource WHERE id = ${id}`);
  if (deleted !== 1) throw campus(500, '资源不存在');
}

export async function campusCsrf(env: AppEnv, request: FastifyRequest) {
  const token = campusAdminToken(request);
  if (!token) throw campus(401, '登录状态已失效');
  return createCampusCsrf(env, token);
}

export async function campusLogout(db: CampusDb, env: AppEnv, request: FastifyRequest) {
  const token = campusAdminToken(request);
  await removeCampusCsrf(env, token);
  const userId = await campusLoginId(env, token);
  if (userId && token) {
    await authRedis(env).del(
      `campus_admin_token:campus-admin:token:${token}`,
      `campus-admin:login-user:${token}`,
    );
    await authRedis(env).srem(`campus-admin:user-tokens:${userId}`, token);
  }
  void db;
}

export async function checkCampusQrLogin(db: CampusDb, env: AppEnv, sceneId: string) {
  if (!sceneId) throw campus(500, 'sceneId不能为空');
  if (sceneId.length > 128) throw campus(500, 'sceneId长度不合法');
  if (!/^login_[A-Za-z0-9_]+$/.test(sceneId)) throw campus(121012, '二维码场景值不合法');
  return withLock(env, `campus-circle:qr-login:${sceneId}`, 2000, 8, 'PROCESSING', async () => {
    const status = await authRedis(env).get(`WxQrCode_${sceneId}`);
    if (!status) return { status: 'EXPIRED', ticket: null };
    if (status === '未扫码') return { status: 'WAITING', ticket: null };
    if (status !== '已关注') return { status: 'SCANNED', ticket: null };
    const log = await queryOne(
      db,
      sql`SELECT user_id FROM t_wx_login_log
          WHERE delete_flag = 'NOT_DELETE' AND qr_scene_str = ${sceneId} LIMIT 1`,
    );
    const userId = cellText(log, 'user_id');
    if (!userId) throw campus(121012, '扫码用户不存在');
    const token = randomBytes(16).toString('hex');
    await saveClientToken(env, token, userId);
    const ticket = randomToken(64);
    await authRedis(env).set(`campus-circle:login-ticket:${ticket}`, token, 'EX', 60);
    await authRedis(env).del(`WxQrCode_${sceneId}`);
    return { status: 'SUCCESS', ticket };
  }).catch((error: unknown) => {
    if (error instanceof Error && error.message === 'PROCESSING') return { status: 'PROCESSING', ticket: null };
    throw error;
  });
}

export async function exchangeCampusTicket(db: CampusDb, env: AppEnv, ticket: string) {
  void db;
  if (!ticket || !/^[A-Za-z0-9]+$/.test(ticket)) throw campus(121012, '登录票据已失效');
  const token = await withLock(env, `campus-circle:login-ticket:${ticket}:lock`, 2000, 5, '登录票据已失效', async () => {
    const redis = authRedis(env);
    const stored = await redis.get(`campus-circle:login-ticket:${ticket}`);
    if (!stored) throw campus(121012, '登录票据已失效');
    await redis.del(`campus-circle:login-ticket:${ticket}`);
    return stored;
  });
  return { token, expiresIn: env.CLIENT_TOKEN_TTL_SECONDS };
}
