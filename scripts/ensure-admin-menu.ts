import { loadEnv } from '@/config/env.js';
import { createDatabase } from '@/infrastructure/database.js';
import { ensureAdminMenus } from '@/modules/admin/admin-menu-routes.js';

const env = loadEnv();
const db = createDatabase(env);
await ensureAdminMenus(db);
await db.destroy();
console.log(`admin_menu ready on ${env.DATABASE_HOST}:${env.DATABASE_PORT}/${env.DATABASE_NAME}`);
