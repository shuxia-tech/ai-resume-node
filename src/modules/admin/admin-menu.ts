import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '@/infrastructure/database.js';

type ResourceRow = {
  id: string;
  parentId: string | null;
  title: string | null;
  name: string | null;
  category: string;
  module: string | null;
  menuType: string | null;
  path: string | null;
  component: string | null;
  icon: string | null;
  sortCode: number | null;
};

type MenuNode = {
  id: string;
  parentId: string;
  name: string | null;
  path: string | null;
  component: string | null;
  title: string | null;
  sortCode: number | null;
  meta: {
    icon: string | null;
    title: string | null;
    type: string;
    affix?: boolean;
    hidden?: boolean;
  };
  children?: MenuNode[];
};

export async function buildLoginMenu(db: Kysely<Database>, userId: string): Promise<MenuNode[]> {
  const resources = await sql<ResourceRow>`
    SELECT ID AS id, PARENT_ID AS parentId, TITLE AS title, NAME AS name, CATEGORY AS category,
           MODULE AS module, MENU_TYPE AS menuType, PATH AS path, COMPONENT AS component,
           ICON AS icon, SORT_CODE AS sortCode
    FROM sys_resource
    WHERE DELETE_FLAG = 'NOT_DELETE'
      AND CATEGORY IN ('MODULE', 'MENU', 'SPA')
    ORDER BY CATEGORY ASC, SORT_CODE ASC, ID ASC
  `.execute(db);
  const rows = resources.rows;
  const modules = rows.filter((row) => row.category === 'MODULE');
  const menus = rows.filter((row) => row.category === 'MENU');
  const spas = rows.filter((row) => row.category === 'SPA');
  const menuById = new Map(menus.map((row) => [row.id, row]));

  const granted = await sql<{ targetId: string }>`
    SELECT DISTINCT TARGET_ID AS targetId
    FROM sys_relation
    WHERE (CATEGORY = 'SYS_USER_HAS_RESOURCE' AND OBJECT_ID = ${userId})
       OR (
         CATEGORY = 'SYS_ROLE_HAS_RESOURCE'
         AND OBJECT_ID IN (
           SELECT TARGET_ID FROM sys_relation
           WHERE OBJECT_ID = ${userId} AND CATEGORY = 'SYS_USER_HAS_ROLE'
         )
       )
  `.execute(db);
  const included = new Set<string>();
  for (const row of granted.rows) includeMenu(menuById, row.targetId, included);

  const ownedMenus = menus.filter((row) => included.has(row.id));
  const moduleIds = new Set(ownedMenus.map((row) => row.module).filter((id): id is string => Boolean(id)));
  let ownedModules = modules.filter((row) => moduleIds.has(row.id));
  if (ownedModules.length === 0 && modules[0]) ownedModules = [modules[0]];
  const firstModule = ownedModules[0];

  const nodes = [
    ...ownedModules.map((row) => toNode(row, '0', row.path || `/${row.id}`, 'module')),
    ...ownedMenus.map((row) =>
      toNode(row, row.parentId === '0' ? row.module || '0' : row.parentId || '0', row.path, menuType(row)),
    ),
    ...spas.map((row, index) => {
      const node = toNode(
        row,
        firstModule?.id ?? '0',
        row.path,
        'menu',
      );
      if (index === 0) node.meta.affix = true;
      else node.meta.hidden = true;
      if (firstModule) node.module = firstModule.id;
      return node;
    }),
  ];
  return tree(nodes);
}

function includeMenu(menuById: Map<string, ResourceRow>, id: string, included: Set<string>) {
  const row = menuById.get(id);
  if (!row || included.has(row.id)) return;
  included.add(row.id);
  if (row.parentId && row.parentId !== '0') includeMenu(menuById, row.parentId, included);
}

function menuType(row: ResourceRow): string {
  if (row.menuType && row.menuType !== 'CATALOG') return row.menuType.toLowerCase();
  return 'menu';
}

function toNode(row: ResourceRow, parentId: string, path: string | null, type: string): MenuNode & { module?: string } {
  return {
    id: row.id,
    parentId,
    name: row.name,
    path,
    component: row.component,
    title: row.title,
    sortCode: row.sortCode,
    meta: { icon: row.icon, title: row.title, type },
  };
}

function tree(nodes: MenuNode[]): MenuNode[] {
  const byParent = new Map<string, MenuNode[]>();
  for (const node of nodes) {
    const list = byParent.get(node.parentId) ?? [];
    list.push(node);
    byParent.set(node.parentId, list);
  }
  const attach = (parentId: string): MenuNode[] =>
    (byParent.get(parentId) ?? [])
      .sort((left, right) => (left.sortCode ?? 0) - (right.sortCode ?? 0))
      .map((node) => {
        const children = attach(node.id);
        return children.length > 0 ? { ...node, children } : node;
      });
  return attach('0');
}
