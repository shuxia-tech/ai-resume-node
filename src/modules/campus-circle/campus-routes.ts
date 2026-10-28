import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { readAuthCache, requestToken, requireUser } from '@/auth/request-user.js';
import { AppError } from '@/common/errors.js';
import { ok } from '@/common/http-response.js';
import type { AppEnv } from '@/config/env.js';
import type { Database } from '@/infrastructure/database.js';
import type { Kysely } from 'kysely';
import {
  campusCsrf,
  campusLogin,
  campusLogout,
  checkCampusQrLogin,
  currentCampusSession,
  deleteResource,
  exchangeCampusTicket,
  requireCampusAdmin,
  resourceTree,
  saveResource,
  saveStaff,
  sessionResult,
  staffList,
} from '@/modules/campus-circle/campus-admin.js';
import {
  adminDashboard,
  adminProfileDetail,
  adminProfilePage,
  adminProjectDetail,
  adminProjectPage,
  adminRatingPage,
  adminVerificationDetail,
  adminVerificationPage,
  auditPage,
  copyContact,
  hideRating,
  meSummary,
  myProfile,
  myProjectPage,
  myVerification,
  operateProfile,
  operateProject,
  platformContent,
  publicProfileDetail,
  publicProfilePage,
  publicProjectDetail,
  publicProjectPage,
  reviewProfile,
  reviewProject,
  reviewVerification,
  savePlatformContent,
  sitemapPage,
  submitProfile,
  submitProject,
  submitRating,
  identityVerification,
  submitVerification,
  submitVip,
  todayContacts,
  unlockContact,
  uploadCampusFile,
} from '@/modules/campus-circle/campus-domain.js';
import {
  adminCaseList,
  adminDemandList,
  adminMaterialList,
  adminProviderList,
  advertisingImageFile,
  advertisingImportKeys,
  advertisingRecords,
  commitAdvertisingImport,
  devFileTarget,
  materialFile,
  myDemands,
  myMaterials,
  myProvider,
  providerImageFile,
  publicDemandContact,
  publicDemandDetail,
  publicDemandPage,
  publishedCases,
  publishedMaterials,
  reviewAdvertisingClaim,
  reviewDemand,
  reviewMaterial,
  reviewProvider,
  saveCase,
  saveMaterial,
  submitAdvertisingClaim,
  submitDemand,
  submitProvider,
  uploadAdvertisingImage,
  uploadMaterial,
  uploadOfficialMaterial,
  uploadProviderImage,
  withdrawDemand,
  type UploadFile,
} from '@/modules/campus-circle/campus-marketplace.js';
import {
  CampusError,
  assertCampusCsrf,
  campus,
  campusAdminToken,
  guardRepeat,
  loadCampusAdminSession,
  sendCampusError,
  text,
  writeCampusCookie,
} from '@/modules/campus-circle/campus-support.js';

type CampusOptions = {
  user?: boolean;
  permission?: string;
  role?: string;
  csrf?: boolean;
  repeatMs?: number;
};

function queryOf(request: FastifyRequest) {
  return (request.query ?? {}) as Record<string, unknown>;
}

function bodyOf(request: FastifyRequest) {
  return (request.body && typeof request.body === 'object' ? request.body : {}) as Record<string, unknown>;
}

function mark(request: FastifyRequest, reply: FastifyReply) {
  reply.header('X-Request-Id', String(request.id));
  if (!request.url.includes('/campus-circle/public/')) {
    reply.header('Cache-Control', 'private, no-store');
    reply.header('Pragma', 'no-cache');
  }
}

async function optionalClient(env: AppEnv, request: FastifyRequest): Promise<string | null> {
  const token = requestToken(request);
  if (!token) return null;
  if (env.TEST_AUTH_ENABLED && token === env.TEST_AUTH_TOKEN) {
    request.userId = env.TEST_USER_ID;
    return env.TEST_USER_ID ?? null;
  }
  const userId = (await readAuthCache(env, `token:C:token:${token}`)) || (await readAuthCache(env, `token:token:${token}`));
  if (!userId) return null;
  request.userId = userId;
  return userId;
}

async function adminOnline(env: AppEnv, request: FastifyRequest) {
  try {
    return Boolean(await loadCampusAdminSession(env, campusAdminToken(request)));
  } catch {
    return false;
  }
}

async function readUpload(request: FastifyRequest) {
  const fields: Record<string, string> = {};
  let file: UploadFile | undefined;
  for await (const part of request.parts()) {
    if (part.type === 'file') {
      if (!file) file = { filename: part.filename, mimetype: part.mimetype, buffer: await part.toBuffer() };
    } else {
      fields[part.fieldname] = text(part.value);
    }
  }
  return { fields, file };
}

function attachment(filename: string, extension: string) {
  const encoded = encodeURIComponent(filename).replace(/\+/g, '%20');
  return `attachment; filename="download.${extension}"; filename*=UTF-8''${encoded}`;
}

function sendBytes(reply: FastifyReply, bytes: Buffer, contentType: string, disposition?: string) {
  reply.header('Content-Type', contentType);
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Cache-Control', 'private, no-store');
  if (disposition) reply.header('Content-Disposition', disposition);
  return reply.send(bytes);
}

async function guarded(reply: FastifyReply, task: () => Promise<unknown>) {
  try {
    return await task();
  } catch (error) {
    if (error instanceof CampusError) return sendCampusError(reply, error);
    if (error instanceof AppError) throw error;
    throw error;
  }
}

export function registerCampusCircleRoutes(app: FastifyInstance, env: AppEnv, db: Kysely<Database>) {
  const route = (
    method: 'get' | 'post',
    path: string,
    options: CampusOptions,
    handler: (request: FastifyRequest) => Promise<unknown>,
  ) => {
    app[method](path, async (request, reply) => {
      mark(request, reply);
      try {
        if (options.repeatMs) await guardRepeat(env, request, options.repeatMs);
        if (options.user) await requireUser(env)(request);
        if (options.csrf) await assertCampusCsrf(env, request);
        if (options.permission || options.role) {
          await requireCampusAdmin(db, env, request, options.permission, options.role);
        }
        return ok(await handler(request));
      } catch (error) {
        if (error instanceof CampusError) return sendCampusError(reply, error);
        if (error instanceof AppError) throw error;
        throw error;
      }
    });
  };

  route('get', '/c/campus-circle/public/platform-content', {}, async () => platformContent(db));
  route('get', '/c/campus-circle/public/profile/page', {}, async (request) => publicProfilePage(db, queryOf(request)));
  route('get', '/c/campus-circle/public/profile/detail', {}, async (request) => publicProfileDetail(db, text(queryOf(request).id)));
  route('get', '/c/campus-circle/public/project/page', {}, async (request) => publicProjectPage(db, queryOf(request)));
  route('get', '/c/campus-circle/public/project/detail', {}, async (request) => publicProjectDetail(db, text(queryOf(request).id)));
  route('get', '/c/campus-circle/public/sitemap/page', {}, async (request) => sitemapPage(db, queryOf(request)));

  route('get', '/c/campus-circle/me/summary', { user: true }, async (request) => meSummary(db, request.userId ?? ''));
  route('get', '/c/campus-circle/profile/mine', { user: true }, async (request) => myProfile(db, request.userId ?? ''));
  route('post', '/c/campus-circle/profile/submit', { user: true, repeatMs: 1500 }, async (request) =>
    submitProfile(db, env, request.userId ?? '', bodyOf(request)),
  );
  route('get', '/c/campus-circle/verification/mine', { user: true }, async (request) => myVerification(db, request.userId ?? ''));
  route('post', '/c/campus-circle/verification/submit', { user: true, repeatMs: 1500 }, async (request) =>
    submitVerification(db, env, request.userId ?? '', bodyOf(request)),
  );
  route('get', '/c/campus-circle/project/mine/page', { user: true }, async (request) =>
    myProjectPage(db, request.userId ?? '', queryOf(request)),
  );
  route('post', '/c/campus-circle/project/submit', { user: true, repeatMs: 1500 }, async (request) =>
    submitProject(db, request.userId ?? '', bodyOf(request)),
  );
  route('post', '/c/campus-circle/contact/unlock', { user: true, repeatMs: 800 }, async (request) =>
    unlockContact(db, env, request, request.userId ?? '', bodyOf(request)),
  );
  route('get', '/c/campus-circle/contact/today', { user: true }, async (request) => todayContacts(db, request.userId ?? ''));
  route('post', '/c/campus-circle/contact/copy', { user: true, repeatMs: 300 }, async (request) =>
    copyContact(db, request, request.userId ?? '', bodyOf(request)),
  );
  route('post', '/c/campus-circle/rating/submit', { user: true, repeatMs: 800 }, async (request) =>
    submitRating(db, env, request, request.userId ?? '', bodyOf(request)),
  );

  app.post('/c/campus-circle/file/upload', async (request, reply) => {
    mark(request, reply);
    try {
      await guardRepeat(env, request, 1500);
      await requireUser(env)(request);
      const scene = text(queryOf(request).scene);
      const part = await request.file();
      if (!part) throw new CampusError(121011, '上传图片不能为空');
      const buffer = await part.toBuffer();
      return ok(await uploadCampusFile(db, env, request.userId ?? '', scene, part.filename, buffer));
    } catch (error) {
      if (error instanceof CampusError) return sendCampusError(reply, error);
      throw error;
    }
  });

  route('get', '/auth/c/campus/wx/checkLogin', {}, async (request) => checkCampusQrLogin(db, env, text(queryOf(request).sceneId)));
  route('post', '/auth/c/campus/exchangeTicket', {}, async (request) => exchangeCampusTicket(db, env, text(bodyOf(request).ticket)));

  app.post('/auth/b/campus/doLogin', async (request, reply) => {
    mark(request, reply);
    try {
      const outcome = await campusLogin(db, env, request, bodyOf(request));
      writeCampusCookie(reply, request, outcome.token, false);
      return ok(sessionResult(outcome.session));
    } catch (error) {
      if (error instanceof CampusError) return sendCampusError(reply, error);
      throw error;
    }
  });
  route('get', '/auth/b/campus/getLoginUser', {}, async (request) => sessionResult(await currentCampusSession(db, env, request)));
  route('get', '/auth/b/campus/csrf', {}, async (request) => {
    await currentCampusSession(db, env, request);
    return campusCsrf(env, request);
  });
  app.post('/auth/b/campus/doLogout', async (request, reply) => {
    mark(request, reply);
    try {
      await assertCampusCsrf(env, request);
      await campusLogout(db, env, request);
      writeCampusCookie(reply, request, '', true);
      return ok(null);
    } catch (error) {
      if (error instanceof CampusError) return sendCampusError(reply, error);
      throw error;
    }
  });

  const admin = (method: 'get' | 'post', path: string, permission: string, handler: (request: FastifyRequest) => Promise<unknown>) =>
    route(method, path, { permission, csrf: method === 'post' }, handler);
  admin('get', '/app/campus-circle/dashboard', '/app/campus-circle/dashboard', async () => adminDashboard(db));
  admin('get', '/app/campus-circle/verification/page', '/app/campus-circle/verification/page', async (request) =>
    adminVerificationPage(db, queryOf(request)),
  );
  admin('get', '/app/campus-circle/verification/detail', '/app/campus-circle/verification/detail', async (request) =>
    adminVerificationDetail(db, text(queryOf(request).id)),
  );
  admin('post', '/app/campus-circle/verification/review', '/app/campus-circle/verification/review', async (request) => {
    const session = await requireCampusAdmin(db, env, request, '/app/campus-circle/verification/review');
    await reviewVerification(db, session.id, bodyOf(request));
    return null;
  });
  admin('get', '/app/campus-circle/profile/page', '/app/campus-circle/profile/page', async (request) => adminProfilePage(db, queryOf(request)));
  admin('get', '/app/campus-circle/profile/detail', '/app/campus-circle/profile/detail', async (request) =>
    adminProfileDetail(db, text(queryOf(request).id)),
  );
  admin('post', '/app/campus-circle/profile/review', '/app/campus-circle/profile/review', async (request) => {
    const session = await requireCampusAdmin(db, env, request, '/app/campus-circle/profile/review');
    await reviewProfile(db, session.id, bodyOf(request));
    return null;
  });
  admin('post', '/app/campus-circle/profile/operation', '/app/campus-circle/profile/operation', async (request) => {
    const session = await requireCampusAdmin(db, env, request, '/app/campus-circle/profile/operation');
    await operateProfile(db, session.id, bodyOf(request));
    return null;
  });
  admin('get', '/app/campus-circle/project/page', '/app/campus-circle/project/page', async (request) => adminProjectPage(db, queryOf(request)));
  admin('get', '/app/campus-circle/project/detail', '/app/campus-circle/project/detail', async (request) =>
    adminProjectDetail(db, text(queryOf(request).id)),
  );
  admin('post', '/app/campus-circle/project/review', '/app/campus-circle/project/review', async (request) => {
    const session = await requireCampusAdmin(db, env, request, '/app/campus-circle/project/review');
    await reviewProject(db, session.id, bodyOf(request));
    return null;
  });
  admin('post', '/app/campus-circle/project/operation', '/app/campus-circle/project/operation', async (request) => {
    const session = await requireCampusAdmin(db, env, request, '/app/campus-circle/project/operation');
    await operateProject(db, session.id, bodyOf(request));
    return null;
  });
  admin('get', '/app/campus-circle/rating/page', '/app/campus-circle/rating/page', async (request) => adminRatingPage(db, queryOf(request)));
  admin('post', '/app/campus-circle/rating/hide', '/app/campus-circle/rating/hide', async (request) => {
    const session = await requireCampusAdmin(db, env, request, '/app/campus-circle/rating/hide');
    await hideRating(db, session.id, bodyOf(request));
    return null;
  });
  admin('get', '/app/campus-circle/audit/page', '/app/campus-circle/audit/page', async (request) => auditPage(db, queryOf(request)));
  admin('get', '/app/campus-circle/content/detail', '/app/campus-circle/content/detail', async () => platformContent(db));
  admin('post', '/app/campus-circle/content/save', '/app/campus-circle/content/save', async (request) => {
    const session = await requireCampusAdmin(db, env, request, '/app/campus-circle/content/save');
    return savePlatformContent(db, session.id, bodyOf(request));
  });

  route('get', '/app/campus-circle/settings/resource/tree', { role: 'ADMIN', csrf: false }, async () => resourceTree(db));
  route('post', '/app/campus-circle/settings/resource/save', { role: 'ADMIN', csrf: true }, async (request) => {
    const session = await requireCampusAdmin(db, env, request, undefined, 'ADMIN');
    return saveResource(db, env, session.id, bodyOf(request));
  });
  route('post', '/app/campus-circle/settings/resource/delete', { role: 'ADMIN', csrf: true }, async (request) => {
    await deleteResource(db, env, text(bodyOf(request).id));
    return null;
  });
  route('get', '/app/campus-circle/settings/staff/list', { role: 'ADMIN' }, async () => staffList(db));
  route('post', '/app/campus-circle/settings/staff/save', { role: 'ADMIN', csrf: true }, async (request) => {
    const session = await requireCampusAdmin(db, env, request, undefined, 'ADMIN');
    return saveStaff(db, env, request, session, bodyOf(request));
  });

  const projectPage = '/app/campus-circle/project/page';
  const projectReview = '/app/campus-circle/project/review';

  route('get', '/c/campus-circle/verification/identity', { user: true }, async (request) => identityVerification(db, request.userId ?? ''));
  route('post', '/c/campus-circle/vip/submit', { user: true, repeatMs: 1500 }, async (request) => submitVip(db, env, request.userId ?? '', bodyOf(request)));
  route('get', '/c/campus-circle/public/demand/page', {}, async (request) => publicDemandPage(db, queryOf(request)));
  route('get', '/c/campus-circle/public/demand/detail', {}, async (request) => publicDemandDetail(db, text(queryOf(request).id)));
  route('post', '/c/campus-circle/public/demand/contact', {}, async (request) => publicDemandContact(db, text(bodyOf(request).id)));
  route('get', '/c/campus-circle/demand/mine', { user: true }, async (request) => myDemands(db, request.userId ?? ''));
  route('post', '/c/campus-circle/demand/submit', { user: true, repeatMs: 1500 }, async (request) => submitDemand(db, request.userId ?? '', bodyOf(request)));
  route('post', '/c/campus-circle/demand/withdraw', { user: true, repeatMs: 800 }, async (request) => withdrawDemand(db, request.userId ?? '', bodyOf(request)));
  route('get', '/c/campus-circle/public/material/list', {}, async () => publishedMaterials(db));
  route('get', '/c/campus-circle/material/mine', { user: true }, async (request) => myMaterials(db, request.userId ?? ''));
  route('get', '/c/campus-circle/public/case/list', {}, async () => publishedCases(db));
  route('get', '/c/campus-circle/provider/mine', { user: true }, async (request) => myProvider(db, request.userId ?? ''));
  route('post', '/c/campus-circle/provider/submit', { user: true, repeatMs: 1500 }, async (request) => submitProvider(db, request.userId ?? '', bodyOf(request)));
  route('get', '/c/campus-circle/public/advertising/records', {}, async (request) => advertisingRecords(db, await optionalClient(env, request), false));
  route('get', '/c/campus-circle/advertising/import-keys', { user: true }, async (request) => advertisingImportKeys(db, request.userId ?? ''));
  route('post', '/c/campus-circle/advertising/claims', { user: true, repeatMs: 1500 }, async (request) =>
    submitAdvertisingClaim(db, request.userId ?? '', bodyOf(request)),
  );
  route('post', '/c/campus-circle/advertising/imports/commit', { user: true, repeatMs: 1500 }, async (request) =>
    commitAdvertisingImport(db, request.userId ?? '', bodyOf(request)),
  );

  admin('get', '/app/campus-circle/demand/page', projectPage, async () => adminDemandList(db));
  admin('post', '/app/campus-circle/demand/review', projectReview, async (request) => {
    const session = await requireCampusAdmin(db, env, request, projectReview);
    return reviewDemand(db, session.id, bodyOf(request));
  });
  admin('get', '/app/campus-circle/case/page', projectPage, async () => adminCaseList(db));
  admin('post', '/app/campus-circle/case/save', projectReview, async (request) => {
    const session = await requireCampusAdmin(db, env, request, projectReview);
    return saveCase(db, session.id, bodyOf(request));
  });
  admin('get', '/app/campus-circle/advertising/page', projectPage, async () => advertisingRecords(db, null, true));
  admin('post', '/app/campus-circle/advertising/review', projectReview, async (request) => {
    const session = await requireCampusAdmin(db, env, request, projectReview);
    await reviewAdvertisingClaim(db, session.id, bodyOf(request));
    return null;
  });
  admin('get', '/app/campus-circle/provider/page', projectPage, async () => adminProviderList(db));
  admin('post', '/app/campus-circle/provider/review', projectReview, async (request) => {
    const session = await requireCampusAdmin(db, env, request, projectReview);
    return reviewProvider(db, session.id, bodyOf(request));
  });
  admin('get', '/app/campus-circle/material/page', projectPage, async () => adminMaterialList(db));
  admin('post', '/app/campus-circle/material/review', projectReview, async (request) => reviewMaterial(db, bodyOf(request)));
  admin('post', '/app/campus-circle/material/save', projectReview, async (request) => {
    const session = await requireCampusAdmin(db, env, request, projectReview);
    return saveMaterial(db, session.id, bodyOf(request));
  });

  app.get('/c/campus-circle/public/material/download', async (request, reply) => {
    mark(request, reply);
    return guarded(reply, async () => {
      const file = await materialFile(db, text(queryOf(request).id), await optionalClient(env, request), false);
      return sendBytes(reply, file.bytes, file.contentType, attachment(file.filename ?? 'download', file.extension ?? 'ppt'));
    });
  });
  app.get('/app/campus-circle/material/download', async (request, reply) => {
    mark(request, reply);
    return guarded(reply, async () => {
      await requireCampusAdmin(db, env, request, projectPage);
      const file = await materialFile(db, text(queryOf(request).id), null, true);
      return sendBytes(reply, file.bytes, file.contentType, attachment(file.filename ?? 'download', file.extension ?? 'ppt'));
    });
  });
  app.post('/c/campus-circle/material/upload', async (request, reply) => {
    mark(request, reply);
    return guarded(reply, async () => {
      await requireUser(env)(request);
      const upload = await readUpload(request);
      return ok(await uploadMaterial(db, request.userId ?? '', upload.fields, upload.file));
    });
  });
  app.post('/app/campus-circle/material/upload', async (request, reply) => {
    mark(request, reply);
    return guarded(reply, async () => {
      await assertCampusCsrf(env, request);
      const session = await requireCampusAdmin(db, env, request, projectReview);
      const upload = await readUpload(request);
      return ok(await uploadOfficialMaterial(db, session.id, upload.fields, upload.file));
    });
  });
  app.post('/c/campus-circle/provider/images', async (request, reply) => {
    mark(request, reply);
    return guarded(reply, async () => {
      await requireUser(env)(request);
      const upload = await readUpload(request);
      return ok(await uploadProviderImage(db, request.userId ?? '', upload.file));
    });
  });
  app.post('/c/campus-circle/advertising/images', async (request, reply) => {
    mark(request, reply);
    return guarded(reply, async () => {
      await requireUser(env)(request);
      const upload = await readUpload(request);
      return ok(await uploadAdvertisingImage(db, request.userId ?? '', upload.file));
    });
  });
  app.get('/c/campus-circle/public/provider/images', async (request, reply) => {
    mark(request, reply);
    return guarded(reply, async () => {
      const file = await providerImageFile(db, text(queryOf(request).id), await optionalClient(env, request), await adminOnline(env, request));
      return sendBytes(reply, file.bytes, file.contentType);
    });
  });
  app.get('/c/campus-circle/public/advertising/images', async (request, reply) => {
    mark(request, reply);
    return guarded(reply, async () => {
      const file = await advertisingImageFile(db, text(queryOf(request).id), await optionalClient(env, request), await adminOnline(env, request));
      return sendBytes(reply, file.bytes, file.contentType);
    });
  });
  app.get('/dev/file/download', async (request, reply) => {
    mark(request, reply);
    return guarded(reply, async () => {
      await requireUser(env)(request);
      const id = text(queryOf(request).id);
      const target = await devFileTarget(db, id);
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Cache-Control', 'private, no-store');
      if (target.kind === 'http') {
        let response: Response;
        try {
          response = await fetch(target.url, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
        } catch {
          throw campus(500, `图片读取或传输失败，id值为：${id}`);
        }
        if (!response.ok || !response.body) throw campus(500, `图片读取或传输失败，id值为：${id}`);
        const type = response.headers.get('content-type')?.split(';')[0]?.trim();
        reply.header('Content-Type', type || target.mime);
        return reply.send(Readable.fromWeb(response.body));
      }
      reply.header('Content-Type', target.mime);
      return reply.send(createReadStream(target.path));
    });
  });
}
