import Fastify from 'fastify';
import { DummyDriver, Kysely, MysqlDialect } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '@/config/env.js';
import type { Database } from '@/infrastructure/database.js';
import { getAdminQuestion, updateAdminQuestion } from '@/modules/xingce/xingce-admin-questions.js';
import { saveAdminInterviews } from '@/modules/xingce/xingce-admin-interviews.js';
import { registerXingceRoutes } from '@/modules/xingce/xingce-routes.js';

function memoryDatabase(run: (sql: string, args: readonly unknown[]) => unknown[]) {
  class Driver extends DummyDriver {
    override async acquireConnection() {
      const connection = await super.acquireConnection();
      connection.executeQuery = async <T>(query: {
        sql: string;
        parameters: readonly unknown[];
      }) => ({ rows: run(query.sql, query.parameters) as T[] });
      return connection;
    }
  }
  class Dialect extends MysqlDialect {
    override createDriver() {
      return new Driver();
    }
  }
  return new Kysely<Database>({
    dialect: new Dialect({ pool: { getConnection() {}, end() {} } }),
  });
}

const draft = {
  id: 'draft-fixture',
  batch_id: 'batch-fixture',
  category: '常识判断',
  question_type: 'single',
  stem: '测试题干',
  options_json: '{"A":"甲","B":"乙"}',
  answer: 'B',
  analysis: '测试解析',
  source: '模拟来源',
  status: 'draft',
  payload_json: '{"reviewRequired":true,"sourceImage":"https://example.invalid/source.png"}',
};

describe('行测后台内容管理', () => {
  it('发布草稿先检查并发版本和原页校对，保留已有原图资源', async () => {
    const writes: unknown[][] = [];
    const db = memoryDatabase((sql, args) => {
      if (sql.includes("status = 'published'")) return [];
      if (sql.includes('SELECT')) return [draft];
      if (sql.includes('UPDATE')) writes.push([...args]);
      return [];
    });
    const question = await getAdminQuestion(db, draft.id);
    await expect(
      updateAdminQuestion(db, draft.id, { action: 'publish', version: 'stale' }),
    ).rejects.toMatchObject({ code: 409 });
    await expect(
      updateAdminQuestion(db, draft.id, { action: 'publish', version: question.version }),
    ).rejects.toMatchObject({ code: 400 });
    expect(writes).toHaveLength(0);
    await expect(
      updateAdminQuestion(db, draft.id, {
        action: 'publish',
        version: question.version,
        acknowledged: true,
      }),
    ).resolves.toEqual({ id: draft.id, status: 'published' });
    const payload = writes[0]?.find(
      (value) => typeof value === 'string' && value.includes('user_checked'),
    );
    expect(JSON.parse(String(payload))).toMatchObject({
      reviewRequired: false,
      reviewStatus: 'user_checked',
      sourceImage: 'https://example.invalid/source.png',
    });
    await db.destroy();
  });

  it('面经导入拒绝已有 ID，避免覆盖管理端编辑', async () => {
    const db = memoryDatabase((sql) => {
      if (sql.includes('SELECT')) return [{ payload_json: '{}', delete_flag: 'NOT_DELETE' }];
      throw new Error('不应该写入');
    });
    await expect(
      saveAdminInterviews(db, [
        {
          id: 'interview-fixture',
          title: '面试记录',
          company: '模拟公司',
          status: 'draft',
        },
      ]),
    ).rejects.toMatchObject({ code: 409 });
    await db.destroy();
  });

  it('新增后台内容接口要求管理员，并正确传递题库搜索条件', async () => {
    const queries: (readonly unknown[])[] = [];
    const db = memoryDatabase((sql, args) => {
      if (sql.includes('LOCATE')) queries.push(args);
      if (sql.includes('COUNT(*)')) return [{ total: 0 }];
      return [];
    });
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      reply
        .code(
          typeof (error as { code?: unknown }).code === 'number'
            ? Number((error as { code?: unknown }).code)
            : 500,
        )
        .send();
    });
    registerXingceRoutes(
      app,
      {
        TEST_AUTH_ENABLED: true,
        TEST_AUTH_TOKEN: 'in-memory-test',
        TEST_USER_ID: 'codex_migration_test_admin',
      } as AppEnv,
      db,
    );
    const url =
      '/c/xingce/admin/questions?' +
      new URLSearchParams({ batch: 'batch-fixture', search: '题干', offset: '25' });
    expect((await app.inject(url)).statusCode).toBe(401);
    const response = await app.inject({ url, headers: { token: 'in-memory-test' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ questions: [], pageSize: 25, total: 0 });
    expect(queries).toContainEqual([
      'published',
      'batch-fixture',
      '题干',
      '题干',
      '题干',
      '题干',
      25,
      25,
    ]);
    await app.close();
    await db.destroy();
  });
});
