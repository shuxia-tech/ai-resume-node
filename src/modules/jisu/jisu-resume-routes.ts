import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { AppError } from '@/common/errors.js';
import { ok } from '@/common/http-response.js';
import { requireUser } from '@/auth/request-user.js';
import type { AppEnv } from '@/config/env.js';
import type { Database } from '@/infrastructure/database.js';

export const MAX_JISU_RESUME_LENGTH = 2 * 1024 * 1024;

const PATHS = ['/c/jisu/resume', '/api/c/jisu/resume'] as const;

let tableReady: Promise<void> | undefined;

export function normalizeJisuResumeContent(content: unknown): string {
  if (typeof content !== 'string' || content.trim() === '') {
    throw new AppError(400, '简历内容不能为空');
  }
  const text = content.trim();
  if (text.length > MAX_JISU_RESUME_LENGTH) {
    throw new AppError(400, '简历内容过大');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AppError(400, '简历内容格式不正确');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError(400, '简历内容格式不正确');
  }
  if (!Array.isArray((parsed as { resumes?: unknown }).resumes)) {
    throw new AppError(400, '简历内容格式不正确');
  }
  return text;
}

function ensureJisuResumeTable(db: Kysely<Database>): Promise<void> {
  tableReady ??= sql`
    CREATE TABLE IF NOT EXISTS t_jisu_resume (
      id varchar(64) NOT NULL COMMENT '主键',
      user_id varchar(64) NOT NULL COMMENT 'C端用户',
      content longtext NOT NULL COMMENT '简历工作区JSON',
      delete_flag varchar(32) NOT NULL DEFAULT 'NOT_DELETE' COMMENT '删除标识',
      create_time datetime DEFAULT NULL COMMENT '创建时间',
      update_time datetime DEFAULT NULL COMMENT '更新时间',
      PRIMARY KEY (id),
      UNIQUE KEY uk_jisu_resume_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='极速海投简历'
  `
    .execute(db)
    .then(() => undefined)
    .catch((error: unknown) => {
      tableReady = undefined;
      throw error;
    });
  return tableReady;
}

function duplicateUser(error: unknown): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return code === 'ER_DUP_ENTRY' || code === '1062';
}

export function registerJisuResumeRoutes(
  app: FastifyInstance,
  env: AppEnv,
  db: Kysely<Database>,
) {
  const authenticate = requireUser(env);

  async function readMine(request: FastifyRequest, _reply: FastifyReply) {
    await ensureJisuResumeTable(db);
    const row = await db
      .selectFrom('t_jisu_resume')
      .select('content')
      .where('user_id', '=', request.userId!)
      .where('delete_flag', '=', 'NOT_DELETE')
      .executeTakeFirst();
    return ok({ content: row?.content ?? null });
  }

  async function saveMine(request: FastifyRequest, _reply: FastifyReply) {
    await ensureJisuResumeTable(db);
    const body = (request.body ?? {}) as { content?: unknown };
    const content = normalizeJisuResumeContent(body.content);
    const userId = request.userId!;
    const now = new Date();
    const existing = await db
      .selectFrom('t_jisu_resume')
      .select('id')
      .where('user_id', '=', userId)
      .where('delete_flag', '=', 'NOT_DELETE')
      .executeTakeFirst();
    if (!existing) {
      try {
        await db
          .insertInto('t_jisu_resume')
          .values({
            id: randomUUID().replaceAll('-', ''),
            user_id: userId,
            content,
            delete_flag: 'NOT_DELETE',
            create_time: now,
            update_time: now,
          })
          .execute();
        return ok(null);
      } catch (error) {
        if (!duplicateUser(error)) throw error;
      }
    }
    await db
      .updateTable('t_jisu_resume')
      .set({ content, update_time: now })
      .where('user_id', '=', userId)
      .execute();
    return ok(null);
  }

  for (const path of PATHS) {
    app.get(path, { preHandler: authenticate }, readMine);
    app.post(path, { preHandler: authenticate }, saveMine);
  }
}
