import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { AppError } from '@/common/errors.js';
import { ok } from '@/common/http-response.js';
import type { AppEnv } from '@/config/env.js';
import type { Database } from '@/infrastructure/database.js';
import { requireAdmin } from '@/modules/admin/admin-auth-routes.js';
import {
  idsFrom,
  queryText,
  readUpload,
  registerAdminResources,
  type AdminResource,
} from '@/modules/admin/admin-crud.js';
import { uploadToCos } from '@/modules/storage/cos-service.js';

const MISSING_TABLES: Record<string, string> = {
  sc_cases: `
    CREATE TABLE IF NOT EXISTS sc_cases (
      id varchar(32) NOT NULL,
      delete_flag varchar(32) NOT NULL DEFAULT 'NOT_DELETE',
      create_time datetime NULL,
      update_time datetime NULL,
      user_id varchar(32) NULL,
      title varchar(255) NULL,
      content longtext NULL,
      status varchar(64) NULL,
      view_count int NULL DEFAULT 0,
      likes_count int NULL DEFAULT 0,
      favorites_count int NULL DEFAULT 0,
      templates_json longtext NULL,
      card_record_id varchar(32) NULL,
      cover_img varchar(1000) NULL,
      images text NULL,
      ip varchar(64) NULL,
      ip_city varchar(128) NULL,
      PRIMARY KEY (id)
    )`,
  sc_card_reacrd: `
    CREATE TABLE IF NOT EXISTS sc_card_reacrd (
      id varchar(32) NOT NULL,
      delete_flag varchar(32) NOT NULL DEFAULT 'NOT_DELETE',
      create_time datetime NULL,
      update_time datetime NULL,
      user_id varchar(32) NULL,
      title varchar(255) NULL,
      ext_json longtext NULL,
      PRIMARY KEY (id)
    )`,
  t_ai_content_synopsis: `
    CREATE TABLE IF NOT EXISTS t_ai_content_synopsis (
      id varchar(32) NOT NULL,
      delete_flag varchar(32) NOT NULL DEFAULT 'NOT_DELETE',
      create_time datetime NULL,
      update_time datetime NULL,
      original_address varchar(1000) NULL,
      content_md5 varchar(64) NULL,
      synopsis_info longtext NULL,
      synopsis_mind_map longtext NULL,
      content longtext NULL,
      prompttemplate longtext NULL,
      has_first_synopsis varchar(32) NULL,
      content_words int NULL,
      tags varchar(1000) NULL,
      logical_fallacy longtext NULL,
      methodology longtext NULL,
      medium_type varchar(32) NULL,
      user_id varchar(32) NULL,
      PRIMARY KEY (id)
    )`,
  sc_record_tag: `
    CREATE TABLE IF NOT EXISTS sc_record_tag (
      id varchar(32) NOT NULL,
      delete_flag varchar(32) NOT NULL DEFAULT 'NOT_DELETE',
      create_time datetime NULL,
      update_time datetime NULL,
      user_id varchar(32) NULL,
      tag_name varchar(255) NULL,
      record_count int NULL DEFAULT 0,
      parent_tag_id varchar(32) NULL,
      PRIMARY KEY (id)
    )`,
  sc_record_tag_relations: `
    CREATE TABLE IF NOT EXISTS sc_record_tag_relations (
      id varchar(32) NOT NULL,
      delete_flag varchar(32) NOT NULL DEFAULT 'NOT_DELETE',
      create_time datetime NULL,
      update_time datetime NULL,
      user_id varchar(32) NULL,
      tag_id varchar(32) NULL,
      record_id varchar(32) NULL,
      PRIMARY KEY (id)
    )`,
  sc_template_custom: `
    CREATE TABLE IF NOT EXISTS sc_template_custom (
      id varchar(32) NOT NULL,
      delete_flag varchar(32) NOT NULL DEFAULT 'NOT_DELETE',
      create_time datetime NULL,
      update_time datetime NULL,
      user_id varchar(32) NULL,
      cover_img varchar(1000) NULL,
      template_name varchar(255) NULL,
      template_json longtext NULL,
      PRIMARY KEY (id)
    )`,
};

function table(path: string, name: string, extra: Partial<AdminResource> = {}): AdminResource {
  return {
    path,
    table: name,
    orderBy: ['id asc'],
    ...(MISSING_TABLES[name] ? { createTableSql: MISSING_TABLES[name] } : {}),
    ...extra,
  };
}

function normalizeMemberPackage(body: Record<string, unknown>) {
  const mode = queryText(body.billingMode) || 'MEMBER_UNLIMITED';
  if (mode !== 'MEMBER_UNLIMITED' && mode !== 'COUNT_PACKAGE' && mode !== 'FREE_TRIAL') {
    throw new AppError(400, `不支持的计费模式：${mode}`);
  }
  body.billingMode = mode;
  if (mode === 'FREE_TRIAL') {
    const days = Number(body.giftDay);
    if (!Number.isInteger(days) || days <= 0) throw new AppError(400, '免费体验必须配置领取天数');
    body.currentAmount = 0;
    body.originalAmount = 0;
    body.usageCount = 0;
  } else if (mode === 'COUNT_PACKAGE') {
    const usage = Number(body.usageCount);
    if (!Number.isInteger(usage) || usage <= 0) throw new AppError(400, '按次套餐必须配置购买次数');
    if (body.giftDay == null || body.giftDay === '') body.giftDay = 0;
  } else if (body.usageCount == null || body.usageCount === '') {
    body.usageCount = 0;
  }
}

function normalizeAdSlot(body: Record<string, unknown>) {
  if ('slotCode' in body) {
    body.slotCode = queryText(body.slotCode).toUpperCase();
    if (body.slotCode && !/^[A-Z0-9_]+$/.test(String(body.slotCode))) {
      throw new AppError(400, '广告位编码只允许英文、数字、下划线');
    }
  }
  const target = queryText(body.targetUrl);
  if (target && !/^https?:\/\//i.test(target)) throw new AppError(400, '跳转链接需以 http:// 或 https:// 开头');
}

function normalizeClientUser(body: Record<string, unknown>) {
  if ('shareFreeMember' in body && body.shareFreeMember != null && body.shareFreeMember !== '') {
    const days = Number(body.shareFreeMember);
    if (!Number.isInteger(days) || days < 0 || days > 3) throw new AppError(400, '分享免费会员天数范围是 0 到 3');
  }
  if ('invitationRebateRate' in body && body.invitationRebateRate != null && body.invitationRebateRate !== '') {
    const rate = Number(body.invitationRebateRate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new AppError(400, '邀请码返佣比例范围是 0 到 100');
  }
}

const RESOURCES: AdminResource[] = [
  table('/client/user', 'client_user', {
    orderBy: ['createTime desc'],
    searchLike: ['nickname'],
    searchEq: ['invitationCode'],
    hidden: ['password'],
    writable: [
      'nickname',
      'memberExpirationTime',
      'offerMemberExpirationTime',
      'photoMemberExpirationTime',
      'hasDistributionPromoCode',
      'shareFreeMember',
      'invitationRebateRate',
      'hasOfferDistributionRebate',
      'highestEducation',
      'latestSchool',
      'latestProfession',
      'avatar',
    ],
    actions: ['page', 'edit', 'detail'],
    beforeWrite: normalizeClientUser,
  }),
  table('/app/memberpackage', 'sc_member_package', { beforeWrite: normalizeMemberPackage }),
  table('/app/adslot', 'sc_ad_slot_config', {
    orderBy: ['projectCode asc', 'slotCode asc', 'sortCode asc', 'updateTime desc'],
    query: {
      projectCode: 'eq',
      slotCode: 'like',
      adMode: 'eq',
      title: 'like',
      status: 'eq',
      startTime: 'ge',
      endTime: 'le',
    },
    beforeWrite: normalizeAdSlot,
  }),
  table('/app/photo/template', 'sc_ai_photo_template_config', {
    orderBy: ['sortCode asc', 'updateTime desc'],
    query: { templateCode: 'like', templateName: 'like', gender: 'eq', status: 'eq' },
  }),
  table('/app/resume', 'sc_resume', {
    query: { title: 'like', isPublished: 'eq' },
  }),
  table('/app/resumemodules', 'sc_resume_modules', {
    query: { moduleType: 'eq', moduleContent: 'like' },
  }),
  table('/app/tags', 'sc_tags'),
  table('/app/resumetags', 'sc_resume_tags'),
  table('/app/resumereport', 'sc_resume_report', {
    query: { userId: 'eq', resumeInfo: 'like', jobInfo: 'like' },
  }),
  table('/app/interviewquestions', 'sc_interview_questions', {
    query: {
      userId: 'eq',
      question: 'like',
      type: 'eq',
      assessmentDimensions: 'like',
      resumeAnchor: 'like',
      difficulty: 'eq',
    },
  }),
  table('/app/campusrecruitment', 'sc_campus_recruitment', {
    orderBy: ['recordTime desc', 'createTime desc', 'id asc'],
    query: { company: 'like', workLocation: 'like', industry: 'like', positions: 'like', infoType: 'eq' },
  }),
  table('/app/notification', 'sc_notification', {
    query: { type: 'eq', title: 'like', content: 'like', userGroup: 'like' },
  }),
  table('/app/usernotification', 'sc_user_notification'),
  table('/app/userfunctionlimits', 'sc_user_function_limits', {
    query: { functionName: 'like', userId: 'eq' },
  }),
  table('/app/userdoc', 't_user_doc', {
    query: {
      userId: 'eq',
      fileUrl: 'like',
      fileMd5: 'like',
      tokens: 'eq',
      fileName: 'like',
      vectorCollectionName: 'like',
    },
  }),
  table('/app/translationhistory', 't_translation_history', {
    query: { userId: 'eq', originalText: 'like', translatedText: 'like', targetLanguage: 'eq' },
  }),
  table('/app/aicontentsynopsis', 't_ai_content_synopsis', {
    query: {
      originalAddress: 'like',
      contentMd5: 'eq',
      synopsisInfo: 'like',
      mediumType: 'eq',
      userId: 'eq',
    },
  }),
  table('/app/cases', 'sc_cases', {
    query: {
      title: 'like',
      content: 'like',
      status: 'eq',
      viewCount: 'eq',
      likesCount: 'eq',
      favoritesCount: 'eq',
    },
  }),
  table('/app/useractions', 'sc_user_actions'),
  table('/app/templatecustom', 'sc_template_custom', {
    query: { userId: 'eq', templateName: 'like' },
  }),
  table('/app/cardreacrd', 'sc_card_reacrd'),
  table('/app/recordtag', 'sc_record_tag', {
    query: { userId: 'eq', tagName: 'like', parentTagId: 'eq' },
  }),
  table('/app/recordtagrelations', 'sc_record_tag_relations'),
  table('/app/chatgroup', 't_chat_group', { query: { name: 'like' } }),
  table('/app/analyticsevents', 't_analytics_events', {
    orderBy: ['createTime desc'],
    query: { eventName: 'like', userId: 'eq' },
  }),
];

export function registerAdminAppRoutes(app: FastifyInstance, env: AppEnv, db: Kysely<Database>) {
  registerAdminResources(app, env, db, RESOURCES);
  const adminGuard = requireAdmin(env, db);

  app.post('/app/adslot/changeStatus', { preHandler: adminGuard }, async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const id = queryText(body.id);
    const status = queryText(body.status);
    if (!id) throw new AppError(400, '缺少主键');
    if (status !== 'ENABLE' && status !== 'DISABLE') throw new AppError(400, '状态只能是启用或禁用');
    await sql`
      UPDATE sc_ad_slot_config
      SET status = ${status}, update_time = NOW()
      WHERE id = ${id} AND delete_flag = 'NOT_DELETE'
    `.execute(db);
    return ok(null);
  });

  app.post('/app/adslot/upload', { preHandler: adminGuard }, async (request) => {
    const file = await readUpload(request, true);
    return ok(await uploadToCos(env, file.body, file.mimetype, file.filename));
  });

  const setTemplateStatus = async (body: unknown, status: 'ENABLE' | 'DISABLE') => {
    const ids = idsFrom(body, 'id');
    if (ids.length === 0) throw new AppError(400, '集合不能为空');
    await sql`
      UPDATE sc_ai_photo_template_config
      SET status = ${status}, update_time = NOW()
      WHERE delete_flag = 'NOT_DELETE'
        AND id IN (${sql.join(ids.map((id) => sql`${id}`))})
    `.execute(db);
    return ok(null);
  };
  app.post('/app/photo/template/enable', { preHandler: adminGuard }, async (request) =>
    setTemplateStatus(request.body, 'ENABLE'),
  );
  app.post('/app/photo/template/disable', { preHandler: adminGuard }, async (request) =>
    setTemplateStatus(request.body, 'DISABLE'),
  );
  app.post('/app/photo/template/upload', { preHandler: adminGuard }, async (request) => {
    const file = await readUpload(request, true);
    return ok(await uploadToCos(env, file.body, file.mimetype, file.filename));
  });
}
