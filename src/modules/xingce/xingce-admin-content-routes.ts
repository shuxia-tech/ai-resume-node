import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { AppError } from '@/common/errors.js';
import { ok } from '@/common/http-response.js';
import type { AppEnv } from '@/config/env.js';
import type { Database } from '@/infrastructure/database.js';
import { requireAdmin } from '@/modules/admin/admin-auth-routes.js';
import {
  archiveXingceSource,
  listXingceSources,
  readXingceSourceImage,
  signXingceSource,
} from '@/modules/storage/cos-service.js';
import { exportAdminBatch } from '@/modules/xingce/xingce-admin-batches.js';
import {
  contentText,
  createAdminDraft,
  getAdminQuestion,
  listAdminQuestions,
  listAdminQuestionSources,
  objectValue,
  updateAdminQuestion,
} from '@/modules/xingce/xingce-admin-questions.js';
import {
  adminInterviews,
  getAdminInterview,
  saveAdminInterviews,
} from '@/modules/xingce/xingce-admin-interviews.js';

type Id = { Params: { id: string } };
type Query = { Querystring: Record<string, string | undefined> };
const ARCHIVE_TYPES = new Map([
  ['pdf', 'application/pdf'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
]);

export function registerAdminContentRoutes(
  app: FastifyInstance,
  env: AppEnv,
  db: Kysely<Database>,
  ensureTables: () => Promise<void>,
) {
  app.register(
    async (admin) => {
      admin.addHook('preHandler', requireAdmin(env, db));
      admin.addHook('preHandler', ensureTables);

      admin.get<Query>('/questions', async (req) => ok(await listAdminQuestions(db, req.query)));
      admin.get<Query>('/questions/sources', async (req) =>
        ok(await listAdminQuestionSources(db, contentText(req.query.batch, 80))),
      );
      admin.get<Query>('/questions/export', async (req) =>
        ok(await exportAdminBatch(db, undefined, req.query.scope === 'published')),
      );
      admin.get<Id>('/questions/:id', async (req) => ok(await getAdminQuestion(db, req.params.id)));
      admin.post('/questions', async (req) => ok(await createAdminDraft(db, req.body)));
      admin.post<Id>('/questions/:id', { bodyLimit: 2 * 1024 * 1024 }, async (req) =>
        ok(await updateAdminQuestion(db, req.params.id, req.body)),
      );

      admin.get<Query>('/interviews', async (req) => ok(await adminInterviews(db, false, req.query)));
      admin.get('/interviews/export', async () => ok(await adminInterviews(db, true)));
      admin.get<Id>('/interviews/:id', async (req) =>
        ok(await getAdminInterview(db, req.params.id)),
      );
      admin.post('/interviews', { bodyLimit: 2 * 1024 * 1024 }, async (req) => {
        const body = objectValue(req.body);
        const entries = Array.isArray(body.entries) ? body.entries : [body.entry];
        return ok(await saveAdminInterviews(db, entries, contentText(body.version, 64)));
      });

      admin.get<Query>('/originals', async (req) =>
        ok(await listXingceSources(env, req.query.marker)),
      );
      admin.get<Query>('/originals/url', async (req) =>
        ok({ url: await signXingceSource(env, contentText(req.query.key, 600)) }),
      );
      admin.get<Query>('/originals/image', async (req, reply) => {
        const key = contentText(req.query.key, 600);
        const body = await readXingceSourceImage(env, key);
        return reply
          .header('Cache-Control', 'private, no-store')
          .type(
            ARCHIVE_TYPES.get(key.split('.').at(-1)?.toLowerCase() ?? '') ??
              'application/octet-stream',
          )
          .send(body);
      });
      admin.post('/originals', async (req) => {
        const file = await req.file({ limits: { fileSize: 8 * 1024 * 1024 } });
        if (!file) throw new AppError(400, '请选择原始资料');
        const extension = file.filename.split('.').at(-1)?.toLowerCase() ?? '';
        const contentType = ARCHIVE_TYPES.get(extension);
        if (!contentType || file.mimetype !== contentType)
          throw new AppError(400, '原始资料仅支持 PDF、PNG、JPEG 或 WebP');
        const data = await file.toBuffer();
        return ok(await archiveXingceSource(env, data, file.filename, contentType));
      });
    },
    { prefix: '/c/xingce/admin' },
  );
}
