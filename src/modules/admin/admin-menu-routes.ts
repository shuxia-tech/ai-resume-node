import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { AppError } from '@/common/errors.js';
import { ok } from '@/common/http-response.js';
import type { AppEnv } from '@/config/env.js';
import type { Database } from '@/infrastructure/database.js';
import { requireAdmin } from '@/modules/admin/admin-auth-routes.js';

type MenuRow = {
  id: string;
  parentId: string | null;
  title: string;
  path: string;
  icon: string | null;
  sortCode: number;
  enabled: number;
  protected: number;
  deleted: number;
};

type MenuNode = {
  id: string;
  parentId: string | null;
  title: string;
  path: string;
  icon: string;
  sortCode: number;
  enabled: boolean;
  protected: boolean;
  children?: MenuNode[];
};

type SidebarNode = {
  key: string;
  title: string;
  path: string;
  icon?: string;
  children?: SidebarNode[];
};

const SEED: Array<Omit<MenuRow, 'enabled' | 'deleted'> & { enabled?: number }> = [
  { id: 'dashboard', parentId: null, title: '流量分析', path: '/dashboard', icon: 'DataAnalysis', sortCode: 10, protected: 0 },
  { id: 'campus', parentId: null, title: '校园招聘', path: '/business/campus', icon: 'School', sortCode: 20, protected: 0 },
  { id: 'client-user', parentId: null, title: '用户管理', path: '/business/client-user', icon: 'User', sortCode: 30, protected: 0 },
  { id: 'distribution', parentId: null, title: '分销数据', path: '/business/distribution', icon: 'Share', sortCode: 40, protected: 0 },
  { id: 'redeem-code', parentId: null, title: '兑换码', path: '/business/redeem-code', icon: 'Ticket', sortCode: 50, protected: 0 },
  { id: 'ai-optimize-group', parentId: null, title: '简历AI优化', path: '', icon: 'MagicStick', sortCode: 60, protected: 0 },
  { id: 'ai-optimize', parentId: 'ai-optimize-group', title: '简历AI优化记录', path: '/business/ai-optimize', icon: 'Tickets', sortCode: 10, protected: 0 },
  { id: 'ai-optimize-user', parentId: 'ai-optimize-group', title: '简历AI优化用户汇总', path: '/business/ai-optimize-user', icon: 'Tickets', sortCode: 20, protected: 0 },
  { id: 'resume-group', parentId: null, title: '简历板块', path: '', icon: 'Document', sortCode: 70, protected: 0 },
  { id: 'resume', parentId: 'resume-group', title: '简历信息', path: '/business/resume', icon: 'Tickets', sortCode: 10, protected: 0 },
  { id: 'resume-modules', parentId: 'resume-group', title: '简历模块', path: '/business/resume-modules', icon: 'Tickets', sortCode: 20, protected: 0 },
  { id: 'resume-report', parentId: 'resume-group', title: '简历报告', path: '/business/resume-report', icon: 'Tickets', sortCode: 30, protected: 0 },
  { id: 'ad-slot', parentId: null, title: '营销广告', path: '/business/ad-slot', icon: 'Picture', sortCode: 80, protected: 0 },
  { id: 'member-package', parentId: null, title: '会员套餐', path: '/business/member-package', icon: 'Goods', sortCode: 90, protected: 0 },
  { id: 'payment-order', parentId: null, title: '订单列表', path: '/business/payment-order', icon: 'Wallet', sortCode: 95, protected: 0 },
  { id: 'notification', parentId: null, title: '通知', path: '/business/notification', icon: 'Bell', sortCode: 100, protected: 0 },
  { id: 'resume-tags', parentId: null, title: '标签关联', path: '/business/resume-tags', icon: 'PriceTag', sortCode: 110, protected: 0 },
  { id: 'function-limits', parentId: null, title: '使用限制', path: '/business/function-limits', icon: 'Lock', sortCode: 120, protected: 0 },
  { id: 'translation', parentId: null, title: '翻译历史', path: '/business/translation', icon: 'ChatLineSquare', sortCode: 130, protected: 0 },
  { id: 'interview-questions', parentId: null, title: 'AI面试题', path: '/business/interview-questions', icon: 'QuestionFilled', sortCode: 140, protected: 0 },
  { id: 'photo-group', parentId: null, title: '证件照模块', path: '', icon: 'Camera', sortCode: 150, protected: 0 },
  { id: 'photo-template', parentId: 'photo-group', title: '证件照模板', path: '/business/photo-template', icon: 'Tickets', sortCode: 10, protected: 0 },
  { id: 'photo-generation', parentId: 'photo-group', title: '证件照生成记录', path: '/business/photo-generation', icon: 'Tickets', sortCode: 20, protected: 0 },
  { id: 'photo-member', parentId: 'photo-group', title: '证件照次数', path: '/business/photo-member', icon: 'Tickets', sortCode: 30, protected: 0 },
  { id: 'settings-group', parentId: null, title: '系统设置', path: '', icon: 'Setting', sortCode: 200, protected: 1 },
  { id: 'settings-menu', parentId: 'settings-group', title: '菜单管理', path: '/settings/menu', icon: 'Menu', sortCode: 10, protected: 1 },
];

let ready: Promise<void> | undefined;

export function ensureAdminMenus(db: Kysely<Database>): Promise<void> {
  ready ??= createAndSeed(db).catch((error: unknown) => {
    ready = undefined;
    throw error;
  });
  return ready;
}

async function createAndSeed(db: Kysely<Database>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS admin_menu (
      id varchar(64) NOT NULL,
      parent_id varchar(64) NULL,
      title varchar(64) NOT NULL,
      path varchar(255) NOT NULL DEFAULT '',
      icon varchar(64) NULL,
      sort_code int NOT NULL DEFAULT 0,
      enabled tinyint NOT NULL DEFAULT 1,
      protected tinyint NOT NULL DEFAULT 0,
      deleted tinyint NOT NULL DEFAULT 0,
      create_time datetime NOT NULL,
      update_time datetime NOT NULL,
      PRIMARY KEY (id),
      KEY idx_admin_menu_parent (parent_id, deleted, sort_code)
    )
  `.execute(db);
  const count = await sql<{ total: number }>`SELECT COUNT(*) AS total FROM admin_menu`.execute(db);
  if (Number(count.rows[0]?.total ?? 0) > 0) {
    await ensurePaymentOrderMenu(db);
    return;
  }
  const now = new Date();
  await db.transaction().execute(async (trx) => {
    const again = await sql<{ total: number }>`SELECT COUNT(*) AS total FROM admin_menu`.execute(trx);
    if (Number(again.rows[0]?.total ?? 0) > 0) return;
    for (const item of SEED) {
      await sql`
        INSERT INTO admin_menu
          (id, parent_id, title, path, icon, sort_code, enabled, protected, deleted, create_time, update_time)
        VALUES
          (${item.id}, ${item.parentId}, ${item.title}, ${item.path}, ${item.icon}, ${item.sortCode}, 1, ${item.protected}, 0, ${now}, ${now})
      `.execute(trx);
    }
  });
}

async function ensurePaymentOrderMenu(db: Kysely<Database>) {
  const item = SEED.find((entry) => entry.id === 'payment-order');
  if (!item) return;
  const existing = await sql<{ id: string }>`SELECT id FROM admin_menu WHERE id = ${item.id} LIMIT 1`.execute(db);
  if (existing.rows.length > 0) return;
  const now = new Date();
  await sql`
    INSERT INTO admin_menu
      (id, parent_id, title, path, icon, sort_code, enabled, protected, deleted, create_time, update_time)
    VALUES
      (${item.id}, ${item.parentId}, ${item.title}, ${item.path}, ${item.icon}, ${item.sortCode}, 1, ${item.protected}, 0, ${now}, ${now})
  `.execute(db);
}

async function listRows(db: Kysely<Database>): Promise<MenuRow[]> {
  const result = await sql<MenuRow>`
    SELECT id, parent_id AS parentId, title, path, icon, sort_code AS sortCode,
           enabled, protected, deleted
    FROM admin_menu
    ORDER BY sort_code ASC, id ASC
  `.execute(db);
  return result.rows;
}

function childrenOf(rows: MenuRow[], parentId: string | null): MenuRow[] {
  return rows
    .filter((row) => (row.parentId ?? null) === parentId)
    .sort((left, right) => left.sortCode - right.sortCode || left.id.localeCompare(right.id));
}

function isReachable(rows: MenuRow[], row: MenuRow): boolean {
  const byId = new Map(rows.map((item) => [item.id, item]));
  let current: MenuRow | undefined = row;
  const seen = new Set<string>();
  while (current) {
    if (current.deleted || !current.enabled || seen.has(current.id)) return false;
    seen.add(current.id);
    if (!current.parentId) return true;
    current = byId.get(current.parentId);
    if (!current) return false;
  }
  return false;
}

function toNode(row: MenuRow, children: MenuNode[] | undefined): MenuNode {
  return {
    id: row.id,
    parentId: row.parentId,
    title: row.title,
    path: row.path,
    icon: row.icon || 'Tickets',
    sortCode: row.sortCode,
    enabled: Boolean(row.enabled),
    protected: Boolean(row.protected),
    ...(children?.length ? { children } : {}),
  };
}

function manageTree(rows: MenuRow[], parentId: string | null = null): MenuNode[] {
  return childrenOf(rows, parentId)
    .filter((row) => !row.deleted)
    .map((row) => toNode(row, manageTree(rows, row.id)));
}

function manageForest(rows: MenuRow[]): MenuNode[] {
  const tree = manageTree(rows);
  const activeIds = new Set(rows.filter((row) => !row.deleted).map((row) => row.id));
  const orphans = rows.filter((row) => !row.deleted && row.parentId && !activeIds.has(row.parentId));
  return [...tree, ...orphans.map((row) => toNode(row, manageTree(rows, row.id)))];
}

function sidebarTree(rows: MenuRow[], parentId: string | null = null): SidebarNode[] {
  const nodes: SidebarNode[] = [];
  for (const row of childrenOf(rows, parentId)) {
    if (!isReachable(rows, row)) continue;
    const children = sidebarTree(rows, row.id);
    if (!row.path && !children.length) continue;
    nodes.push({
      key: row.id,
      title: row.title,
      path: row.path,
      ...(row.icon ? { icon: row.icon } : {}),
      ...(children.length ? { children } : {}),
    });
  }
  return nodes;
}

function pathStates(rows: MenuRow[]): Array<{ path: string; open: boolean }> {
  const states = new Map<string, boolean>();
  for (const row of rows) {
    if (!row.path) continue;
    const open = isReachable(rows, row);
    states.set(row.path, states.get(row.path) || open);
  }
  return [...states.entries()].map(([path, open]) => ({ path, open }));
}

async function requireRow(db: Kysely<Database>, id: string): Promise<MenuRow> {
  const row = (await listRows(db)).find((item) => item.id === id);
  if (!row || row.deleted) throw new AppError(404, '菜单不存在');
  return row;
}

function cleanTitle(value: unknown): string {
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title) throw new AppError(400, '菜单名称不能为空');
  if (title.length > 32) throw new AppError(400, '菜单名称不能超过 32 个字');
  return title;
}

function cleanPath(value: unknown): string {
  const path = typeof value === 'string' ? value.trim() : '';
  if (!path) return '';
  if (!path.startsWith('/')) throw new AppError(400, '路由需要以 / 开头');
  if (path.length > 255) throw new AppError(400, '路由过长');
  return path;
}

function cleanIcon(value: unknown): string {
  const icon = typeof value === 'string' ? value.trim() : '';
  if (icon.length > 64) throw new AppError(400, '图标名称过长');
  return icon || 'Tickets';
}

async function assertParent(db: Kysely<Database>, parentId: string | null, movingId?: string): Promise<void> {
  if (!parentId) return;
  if (parentId === movingId) throw new AppError(400, '不能把菜单放到自己下面');
  const rows = await listRows(db);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const seen = new Set<string>();
  let current = parentId;
  while (current) {
    if (current === movingId) throw new AppError(400, '不能把菜单放到自己的子菜单下面');
    if (seen.has(current)) throw new AppError(400, '菜单层级有循环');
    seen.add(current);
    const row = byId.get(current);
    if (!row || row.deleted) throw new AppError(400, '上级菜单不存在');
    current = row.parentId ?? '';
  }
}

async function assertPathAvailable(db: Kysely<Database>, path: string, currentId?: string): Promise<void> {
  if (!path) return;
  const duplicated = (await listRows(db)).find((row) => !row.deleted && row.path === path && row.id !== currentId);
  if (duplicated) throw new AppError(400, '这个路由已经有菜单在使用');
}

async function nextSort(db: Kysely<Database>, parentId: string | null): Promise<number> {
  const siblings = childrenOf(await listRows(db), parentId).filter((row) => !row.deleted);
  return siblings.reduce((max, row) => Math.max(max, row.sortCode), 0) + 10;
}

export function registerAdminMenuRoutes(app: FastifyInstance, env: AppEnv, db: Kysely<Database>): void {
  const adminGuard = requireAdmin(env, db);

  app.get('/app/menu/bootstrap', { preHandler: adminGuard }, async () => {
    await ensureAdminMenus(db);
    const rows = await listRows(db);
    return ok({ sidebar: sidebarTree(rows), paths: pathStates(rows) });
  });

  app.get('/app/menu/manage', { preHandler: adminGuard }, async () => {
    await ensureAdminMenus(db);
    return ok(manageForest(await listRows(db)));
  });

  app.get('/app/menu/deleted', { preHandler: adminGuard }, async () => {
    await ensureAdminMenus(db);
    const rows = await listRows(db);
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ok(
      rows
        .filter((row) => row.deleted)
        .map((row) => ({
          id: row.id,
          title: row.title,
          path: row.path,
          parentTitle: row.parentId ? byId.get(row.parentId)?.title ?? '已删除的上级' : '一级菜单',
        })),
    );
  });

  app.post<{ Body: { parentId?: string | null; title?: string; path?: string; icon?: string } }>(
    '/app/menu/add',
    { preHandler: adminGuard },
    async (request) => {
      await ensureAdminMenus(db);
      const parentId = request.body?.parentId || null;
      const title = cleanTitle(request.body?.title);
      const path = cleanPath(request.body?.path);
      const icon = cleanIcon(request.body?.icon);
      await assertParent(db, parentId);
      await assertPathAvailable(db, path);
      const now = new Date();
      const id = `menu${randomBytes(8).toString('hex')}`;
      await sql`
        INSERT INTO admin_menu
          (id, parent_id, title, path, icon, sort_code, enabled, protected, deleted, create_time, update_time)
        VALUES
          (${id}, ${parentId}, ${title}, ${path}, ${icon}, ${await nextSort(db, parentId)}, 1, 0, 0, ${now}, ${now})
      `.execute(db);
      return ok({ id });
    },
  );

  app.post<{ Body: { id?: string; parentId?: string | null; title?: string; path?: string; icon?: string } }>(
    '/app/menu/edit',
    { preHandler: adminGuard },
    async (request) => {
      await ensureAdminMenus(db);
      const id = request.body?.id?.trim();
      if (!id) throw new AppError(400, '菜单不能为空');
      const current = await requireRow(db, id);
      if (current.protected) throw new AppError(400, '系统菜单只能调整排序');
      const parentId = request.body?.parentId || null;
      const title = cleanTitle(request.body?.title);
      const path = cleanPath(request.body?.path);
      const icon = cleanIcon(request.body?.icon);
      await assertParent(db, parentId, id);
      await assertPathAvailable(db, path, id);
      const sortCode = parentId === (current.parentId ?? null) ? current.sortCode : await nextSort(db, parentId);
      await sql`
        UPDATE admin_menu
        SET parent_id = ${parentId}, title = ${title}, path = ${path}, icon = ${icon},
            sort_code = ${sortCode}, update_time = ${new Date()}
        WHERE id = ${id}
      `.execute(db);
      return ok(null);
    },
  );

  app.post<{ Body: { id?: string; enabled?: boolean } }>('/app/menu/enabled', { preHandler: adminGuard }, async (request) => {
    await ensureAdminMenus(db);
    const id = request.body?.id?.trim();
    if (!id) throw new AppError(400, '菜单不能为空');
    const current = await requireRow(db, id);
    const enabled = Boolean(request.body?.enabled);
    if (current.protected && !enabled) throw new AppError(400, '系统菜单不能关闭');
    await sql`UPDATE admin_menu SET enabled = ${enabled ? 1 : 0}, update_time = ${new Date()} WHERE id = ${id}`.execute(db);
    return ok(null);
  });

  app.post<{ Body: { parentId?: string | null; ids?: string[] } }>('/app/menu/sort', { preHandler: adminGuard }, async (request) => {
    await ensureAdminMenus(db);
    const parentId = request.body?.parentId || null;
    const ids = request.body?.ids ?? [];
    if (!ids.length) throw new AppError(400, '排序内容不能为空');
    const rows = await listRows(db);
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of ids) {
      const row = byId.get(id);
      if (!row || row.deleted) throw new AppError(404, '菜单不存在');
      if (row.protected && (row.parentId ?? null) !== parentId) throw new AppError(400, '系统菜单不能调整上级');
    }
    await assertParent(db, parentId);
    const now = new Date();
    await db.transaction().execute(async (trx) => {
      for (let index = 0; index < ids.length; index += 1) {
        const id = ids[index];
        if (!id) continue;
        await sql`
          UPDATE admin_menu
          SET parent_id = ${parentId}, sort_code = ${(index + 1) * 10}, update_time = ${now}
          WHERE id = ${id}
        `.execute(trx);
      }
    });
    return ok(null);
  });

  app.post<{ Body: { id?: string } }>('/app/menu/delete', { preHandler: adminGuard }, async (request) => {
    await ensureAdminMenus(db);
    const id = request.body?.id?.trim();
    if (!id) throw new AppError(400, '菜单不能为空');
    const current = await requireRow(db, id);
    if (current.protected) throw new AppError(400, '系统菜单不能删除');
    await sql`UPDATE admin_menu SET deleted = 1, update_time = ${new Date()} WHERE id = ${id}`.execute(db);
    return ok(null);
  });

  app.post<{ Body: { id?: string } }>('/app/menu/restore', { preHandler: adminGuard }, async (request) => {
    await ensureAdminMenus(db);
    const id = request.body?.id?.trim();
    if (!id) throw new AppError(400, '菜单不能为空');
    const rows = await listRows(db);
    const current = rows.find((row) => row.id === id);
    if (!current?.deleted) throw new AppError(404, '已删除的菜单不存在');
    await assertPathAvailable(db, current.path, id);
    await sql`UPDATE admin_menu SET deleted = 0, update_time = ${new Date()} WHERE id = ${id}`.execute(db);
    return ok(null);
  });
}
