/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { AppError } from '@/common/errors.js';
import { ok } from '@/common/http-response.js';
import { isActiveShanghaiWallClock, parseApplicationDate } from '@/common/java-date.js';
import { requireUser } from '@/auth/request-user.js';
import type { AppEnv } from '@/config/env.js';
import type { CampusRecruitmentRow, Database } from '@/infrastructure/database.js';

type CampusQuery = {
  page?: string;
  limit?: string;
  keyword?: string;
  workLocation?: string;
  industry?: string;
  positions?: string;
  recruitmentStatus?: string;
  infoType?: string;
  dataSource?: 'custom' | 'system';
  startDate?: string;
  endDate?: string;
};

type CampusBody = Partial<CampusRecruitmentRow> & {
  recruitmentId?: string;
  recruitmentStatus?: string;
  recruitmentRemarks?: string;
};

const publicColumns = [
  'id',
  'company',
  'work_location as workLocation',
  'industry',
  'positions',
  'title',
  'remarks',
  'record_time as recordTime',
  'info_type as infoType',
  'referral_code as referralCode',
  'referral_method as referralMethod',
  'create_time as createTime',
  'update_time as updateTime',
] as const;

function campusListItem(
  record: Record<string, unknown>,
  status?: { recruitment_status: string | null; recruitment_remarks: string | null },
) {
  return {
    ...record,
    expirationTime: null,
    mainBusiness: null,
    progressCheck: null,
    dataSource: null,
    recruitmentId: null,
    recruitmentStatus: status?.recruitment_status ?? null,
    recruitmentRemarks: status?.recruitment_remarks ?? null,
  };
}

function pageValue(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

/** Custom rows keep the user-table value. System rows prefer the recruitment row, same as the Java CASE. */
function recordDisplayColumn(column: string, alias: string) {
  return sql`CASE WHEN cru.recruitment_id IS NULL OR cru.recruitment_id = '' THEN cru.${sql.raw(column)} ELSE IFNULL(cr.${sql.raw(column)}, cru.${sql.raw(column)}) END`.as(
    alias,
  );
}

/**
 * Keep the Java Snowy CommonPage wire shape while the Node service replaces it.
 * The web clients rely on these names, including the reservedObject placeholder.
 */
function pageData<T>(records: T[], total: number, current: number, size: number) {
  return {
    page: current,
    limit: size,
    totalPage: total > 0 ? Math.ceil(total / size) : 0,
    total,
    list: records,
    reservedObject: null,
  };
}

function addFilters(builder: any, query: CampusQuery, userId?: string): any {
  let result = builder;
  const keyword = query.keyword?.trim();
  if (keyword) {
    result = result.where((eb: any) =>
      eb.or([
        eb('company', 'like', `%${keyword}%`),
        eb('positions', 'like', `%${keyword}%`),
        eb('title', 'like', `%${keyword}%`),
        eb('work_location', 'like', `%${keyword}%`),
        eb('industry', 'like', `%${keyword}%`),
        eb('remarks', 'like', `%${keyword}%`),
        ...(userId
          ? [
              sql<boolean>`EXISTS (SELECT 1 FROM sc_campus_recruitment_user cru WHERE cru.recruitment_id = sc_campus_recruitment.id AND cru.user_id = ${userId} AND cru.recruitment_remarks LIKE ${`%${keyword}%`})`,
            ]
          : []),
      ]),
    );
  }
  for (const [key, column] of [
    ['workLocation', 'work_location'],
    ['industry', 'industry'],
    ['positions', 'positions'],
  ] as const) {
    const value = query[key]?.trim();
    if (value) result = result.where(column, 'like', `%${value}%`);
  }
  if (query.startDate) result = result.where('record_time', '>=', query.startDate);
  if (query.endDate) result = result.where('record_time', '<=', `${query.endDate} 23:59:59`);
  return result;
}

function toRecruitmentInsert(body: CampusBody, id: string) {
  return {
    id,
    company: body.company ?? null,
    referral_code: body.referral_code ?? (body as any).referralCode ?? null,
    referral_method: body.referral_method ?? (body as any).referralMethod ?? null,
    title: body.title ?? null,
    progress_check: body.progress_check ?? (body as any).progressCheck ?? null,
    work_location: body.work_location ?? (body as any).workLocation ?? null,
    industry: body.industry ?? null,
    positions: body.positions ?? null,
    remarks: body.remarks ?? null,
    main_business: body.main_business ?? (body as any).mainBusiness ?? null,
    info_type: body.info_type ?? (body as any).infoType ?? '校招',
    record_time: body.record_time ?? (body as any).recordTime ?? new Date(),
    expiration_time: body.expiration_time ?? (body as any).expirationTime ?? null,
    create_time: new Date(),
    update_time: new Date(),
  };
}

export function registerCampusRoutes(app: FastifyInstance, env: AppEnv, db: Kysely<Database>) {
  const authenticate = requireUser(env);
  const optionalUser = async (request: any) => {
    try {
      await authenticate(request);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 401) throw error;
    }
  };

  async function isOfferMember(userId?: string): Promise<boolean> {
    if (!userId) return false;
    const user = await db
      .selectFrom('client_user')
      .select(['offer_member_expiration_time'])
      .where('ID', '=', userId)
      .where('DELETE_FLAG', '=', 'NOT_DELETE')
      .executeTakeFirst();
    return isActiveShanghaiWallClock(user?.offer_member_expiration_time);
  }

  async function visibleCampusQuery(userId: string | undefined, query: CampusQuery): Promise<CampusQuery> {
    if (await isOfferMember(userId)) return query;
    const { keyword: _keyword, ...rest } = query;
    return { ...rest, page: '1' };
  }

  async function listRecruitments(query: CampusQuery, infoType: '校招' | '内推', userId?: string) {
    const current = pageValue(query.page, 1, 10_000);
    const size = pageValue(query.limit, 10, 100);
    let base = db
      .selectFrom('sc_campus_recruitment')
      .select(publicColumns as any)
      .where('info_type', '=', infoType);
    base = addFilters(base, query, userId) as typeof base;
    if (userId && query.recruitmentStatus) {
      base = base.where(({ exists, selectFrom }: any) =>
        exists(
          selectFrom('sc_campus_recruitment_user as cru')
            .select('cru.id')
            .whereRef('cru.recruitment_id', '=', 'sc_campus_recruitment.id')
            .where('cru.user_id', '=', userId)
            .where('cru.recruitment_status', '=', query.recruitmentStatus!),
        ),
      ) as typeof base;
    }
    const countQuery = db
      .selectFrom('sc_campus_recruitment')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('info_type', '=', infoType);
    const filteredCount = addFilters(countQuery, query, userId);
    const finalCount =
      userId && query.recruitmentStatus
        ? filteredCount.where(({ exists, selectFrom }: any) =>
            exists(
              selectFrom('sc_campus_recruitment_user as cru')
                .select('cru.id')
                .whereRef('cru.recruitment_id', '=', 'sc_campus_recruitment.id')
                .where('cru.user_id', '=', userId)
                .where('cru.recruitment_status', '=', query.recruitmentStatus!),
            ),
          )
        : filteredCount;
    const [records, count] = await Promise.all([
      base
        .orderBy('record_time', 'desc')
        .limit(size)
        .offset((current - 1) * size)
        .execute(),
      finalCount.executeTakeFirst(),
    ]);
    if (!userId) return pageData(records.map((record: any) => campusListItem(record)), Number(count?.count ?? 0), current, size);
    const ids = records.map((record: any) => record.id);
    if (!ids.length) return pageData(records, Number(count?.count ?? 0), current, size);
    const statuses = await db
      .selectFrom('sc_campus_recruitment_user')
      .select(['recruitment_id', 'recruitment_status', 'recruitment_remarks'])
      .where('user_id', '=', userId)
      .where('recruitment_id', 'in', ids)
      .execute();
    const statusMap = new Map(statuses.map((item) => [item.recruitment_id, item]));
    return pageData(
      records.map((record: any) => campusListItem(record, statusMap.get(record.id))),
      Number(count?.count ?? 0),
      current,
      size,
    );
  }

  app.get('/c/resume/campusRecruitment', { preHandler: optionalUser }, async (request) => {
    const query = await visibleCampusQuery(request.userId, request.query as CampusQuery);
    return ok(await listRecruitments(query, '校招', request.userId));
  });
  app.get('/c/resume/campusRecruitment/referral', { preHandler: optionalUser }, async (request) => {
    const query = await visibleCampusQuery(request.userId, request.query as CampusQuery);
    return ok(await listRecruitments(query, '内推', request.userId));
  });

  app.get('/c/resume/campusRecruitment/stats', async () => {
    // Match the production query: calendar days from CURDATE(), not a rolling
    // timestamp. record_time is stored at local midnight, so a UTC offset of a
    // few hours drops the boundary day.
    const stats = await sql<{
      threeDayCount: number | string | null;
      weekCount: number | string | null;
      totalCount: number | string | null;
    }>`
      SELECT
        SUM(CASE WHEN record_time >= DATE_SUB(CURDATE(), INTERVAL 2 DAY) THEN 1 ELSE 0 END) AS threeDayCount,
        SUM(CASE WHEN record_time >= DATE_SUB(CURDATE(), INTERVAL 6 DAY) THEN 1 ELSE 0 END) AS weekCount,
        COUNT(*) AS totalCount
      FROM sc_campus_recruitment
    `.execute(db);
    const row = stats.rows[0];
    return ok({
      threeDayCount: Number(row?.threeDayCount ?? 0),
      weekCount: Number(row?.weekCount ?? 0),
      totalCount: Number(row?.totalCount ?? 0),
    });
  });

  app.get('/c/resume/campusRecruitment/progress', { preHandler: authenticate }, async (request) => {
    const query = await visibleCampusQuery(request.userId, request.query as CampusQuery);
    const current = pageValue(query.page, 1, 10_000);
    const size = pageValue(query.limit, 10, 100);
    let base = db
      .selectFrom('sc_campus_recruitment as cr')
      .innerJoin('sc_campus_recruitment_user as cru', (join) =>
        join.onRef('cr.id', '=', 'cru.recruitment_id').on('cru.user_id', '=', request.userId!),
      )
      .select([
        ...(publicColumns.map((column) =>
          column.startsWith('id')
            ? 'cr.id'
            : `cr.${column.replace(/ as .+$/, '')} as ${column.includes(' as ') ? column.split(' as ')[1] : column}`,
        ) as any),
        'cru.recruitment_status as recruitmentStatus',
        'cru.recruitment_remarks as recruitmentRemarks',
        sql`NULL`.as('recruitmentId'),
        sql`NULL`.as('expirationTime'),
        sql`NULL`.as('mainBusiness'),
        sql`NULL`.as('progressCheck'),
        sql`NULL`.as('dataSource'),
      ])
      .where((eb: any) =>
        eb.or([
          eb.and([
            eb('cru.recruitment_status', 'is not', null),
            sql`TRIM(cru.recruitment_status) <> ''`,
          ]),
          eb.and([
            eb('cru.recruitment_remarks', 'is not', null),
            sql`TRIM(cru.recruitment_remarks) <> ''`,
          ]),
        ]),
      );
    if (query.recruitmentStatus)
      base = base.where('cru.recruitment_status', '=', query.recruitmentStatus) as typeof base;
    if (query.startDate && query.endDate) {
      base = base.where(
        sql`cr.record_time BETWEEN ${query.startDate} AND ${query.endDate}` as any,
      ) as typeof base;
    }
    if (query.keyword)
      base = base.where((eb: any) =>
        eb.or([
          eb('cr.company', 'like', `%${query.keyword}%`),
          eb('cr.positions', 'like', `%${query.keyword}%`),
          eb('cr.title', 'like', `%${query.keyword}%`),
          eb('cr.work_location', 'like', `%${query.keyword}%`),
          eb('cr.industry', 'like', `%${query.keyword}%`),
          eb('cru.recruitment_remarks', 'like', `%${query.keyword}%`),
        ]),
      ) as typeof base;
    const countQuery = (base as any)
      .clearSelect()
      .select(({ fn }: any) => fn.countAll().as('count'));
    const [records, count] = await Promise.all([
      base
        .orderBy('cr.record_time', 'desc')
        .orderBy('cr.id', 'desc')
        .limit(size)
        .offset((current - 1) * size)
        .execute(),
      countQuery.executeTakeFirst(),
    ]);
    return ok(pageData(records, Number(count?.count ?? 0), current, size));
  });

  app.put('/c/resume/campusRecruitment/status', { preHandler: authenticate }, async (request) =>
    updateRecruitmentUser(db, request.userId!, request.body as CampusBody, false),
  );
  app.put('/c/resume/campusRecruitment/remarks', { preHandler: authenticate }, async (request) =>
    updateRecruitmentUser(db, request.userId!, request.body as CampusBody, false),
  );

  app.get('/c/resume/campusRecruitment/record', { preHandler: authenticate }, async (request) => {
    const query = request.query as CampusQuery;
    const current = pageValue(query.page, 1, 10_000);
    const size = pageValue(query.limit, 10, 100);
    const customRow = (eb: any) =>
      eb.or([eb('cru.recruitment_id', 'is', null), eb('cru.recruitment_id', '=', '')]);
    let base = db
      .selectFrom('sc_campus_recruitment_user as cru')
      .leftJoin('sc_campus_recruitment as cr', 'cr.id', 'cru.recruitment_id')
      .select([
        'cru.id as id',
        'cru.recruitment_id as recruitmentId',
        'cru.recruitment_status as recruitmentStatus',
        'cru.recruitment_remarks as recruitmentRemarks',
        'cru.create_time as createTime',
        'cru.update_time as updateTime',
        recordDisplayColumn('company', 'company'),
        recordDisplayColumn('positions', 'positions'),
        recordDisplayColumn('title', 'title'),
        recordDisplayColumn('work_location', 'workLocation'),
        recordDisplayColumn('industry', 'industry'),
        recordDisplayColumn('referral_code', 'referralCode'),
        recordDisplayColumn('referral_method', 'referralMethod'),
        recordDisplayColumn('progress_check', 'progressCheck'),
        recordDisplayColumn('remarks', 'remarks'),
        sql`IFNULL(cru.record_time, cr.record_time)`.as('recordTime'),
        recordDisplayColumn('expiration_time', 'expirationTime'),
        recordDisplayColumn('main_business', 'mainBusiness'),
        recordDisplayColumn('info_type', 'infoType'),
        sql<string>`CASE WHEN cru.recruitment_id IS NULL OR cru.recruitment_id = '' THEN 'custom' ELSE 'system' END`.as(
          'dataSource',
        ),
      ])
      .where('cru.user_id', '=', request.userId!)
      .where((eb: any) => eb.or([customRow(eb), eb('cr.id', 'is not', null)]))
      .where((eb: any) =>
        eb.or([
          customRow(eb),
          eb.and([
            eb('cru.recruitment_id', 'is not', null),
            eb('cru.recruitment_id', '<>', ''),
            eb('cru.recruitment_status', 'is not', null),
            eb('cru.recruitment_status', '<>', ''),
            eb('cru.recruitment_status', '<>', '取消'),
          ]),
        ]),
      ) as any;
    if (query.dataSource === 'custom') base = base.where(customRow) as typeof base;
    if (query.dataSource === 'system')
      base = base
        .where('cru.recruitment_id', 'is not', null)
        .where('cru.recruitment_id', '<>', '') as typeof base;
    if (query.recruitmentStatus)
      base = base.where('cru.recruitment_status', '=', query.recruitmentStatus) as typeof base;
    if (query.infoType)
      base = base.where(sql`IFNULL(cru.info_type, cr.info_type) = ${query.infoType}`) as typeof base;
    if (query.keyword) {
      const pattern = `%${query.keyword}%`;
      base = base.where((eb: any) =>
        eb.or([
          sql<boolean>`IFNULL(cru.company, cr.company) LIKE ${pattern}`,
          sql<boolean>`IFNULL(cru.positions, cr.positions) LIKE ${pattern}`,
          sql<boolean>`IFNULL(cru.title, cr.title) LIKE ${pattern}`,
          sql<boolean>`IFNULL(cru.work_location, cr.work_location) LIKE ${pattern}`,
          sql<boolean>`IFNULL(cru.industry, cr.industry) LIKE ${pattern}`,
          eb('cru.recruitment_remarks', 'like', pattern),
        ]),
      ) as typeof base;
    }
    if (query.startDate && query.endDate)
      base = base.where(
        sql`DATE(IFNULL(cru.record_time, cr.record_time)) BETWEEN ${query.startDate} AND ${query.endDate}`,
      ) as typeof base;
    const countQuery = (base as any)
      .clearSelect()
      .select(({ fn }: any) => fn.countAll().as('count'));
    const [records, count] = await Promise.all([
      base
        .orderBy(sql`IFNULL(cru.record_time, cr.record_time)`, 'desc')
        .orderBy('cru.id', 'desc')
        .limit(size)
        .offset((current - 1) * size)
        .execute(),
      countQuery.executeTakeFirst(),
    ]);
    return ok(pageData(records, Number(count?.count ?? 0), current, size));
  });

  app.post('/c/resume/campusRecruitment/record', { preHandler: authenticate }, async (request) =>
    createUserRecord(db, request.userId!, request.body as CampusBody),
  );
  app.put('/c/resume/campusRecruitment/record/:id', { preHandler: authenticate }, async (request) =>
    updateUserRecord(
      db,
      request.userId!,
      String((request.params as { id: string }).id),
      request.body as CampusBody,
    ),
  );
  app.delete(
    '/c/resume/campusRecruitment/record/:id',
    { preHandler: authenticate },
    async (request) => {
      const id = String((request.params as { id: string }).id);
      const result = await db
        .deleteFrom('sc_campus_recruitment_user')
        .where('id', '=', id)
        .where('user_id', '=', request.userId!)
        .executeTakeFirst();
      if (!Number(result.numDeletedRows)) throw new AppError(404, '记录不存在或无权操作');
      return ok(null);
    },
  );

  app.post('/c/resume/campusRecruitment/custom', { preHandler: authenticate }, async (request) => {
    const body = { ...(request.body as CampusBody), info_type: '校招' };
    delete body.recruitmentId;
    return createUserRecord(db, request.userId!, body);
  });
  app.put('/c/resume/campusRecruitment/custom/:id', { preHandler: authenticate }, async (request) =>
    updateUserRecord(
      db,
      request.userId!,
      String((request.params as { id: string }).id),
      request.body as CampusBody,
      true,
    ),
  );
}

async function updateRecruitmentUser(
  db: Kysely<Database>,
  userId: string,
  body: CampusBody,
  _unused: boolean,
) {
  void _unused;
  if (!body.recruitmentId) throw new AppError(400, 'recruitmentId 不能为空');
  const recruitment = await db
    .selectFrom('sc_campus_recruitment')
    .select('id')
    .where('id', '=', body.recruitmentId)
    .executeTakeFirst();
  if (!recruitment) throw new AppError(404, '招聘信息不存在');
  const existing = await db
    .selectFrom('sc_campus_recruitment_user')
    .selectAll()
    .where('user_id', '=', userId)
    .where('recruitment_id', '=', body.recruitmentId)
    .executeTakeFirst();
  if (body.recruitmentStatus === '取消') {
    if (existing)
      await db.deleteFrom('sc_campus_recruitment_user').where('id', '=', existing.id).execute();
    return ok(null);
  }
  if (!existing) {
    await db
      .insertInto('sc_campus_recruitment_user')
      .values({
        id: randomUUID().replaceAll('-', ''),
        user_id: userId,
        recruitment_id: body.recruitmentId,
        recruitment_status: body.recruitmentStatus ?? null,
        recruitment_remarks: body.recruitmentRemarks ?? null,
        create_time: new Date(),
        update_time: new Date(),
      } as any)
      .execute();
  } else {
    await db
      .updateTable('sc_campus_recruitment_user')
      .set({
        recruitment_status: body.recruitmentStatus ?? existing.recruitment_status,
        recruitment_remarks: body.recruitmentRemarks ?? existing.recruitment_remarks,
        update_time: new Date(),
      })
      .where('id', '=', existing.id)
      .execute();
  }
  return ok(null);
}

async function createUserRecord(db: Kysely<Database>, userId: string, body: CampusBody) {
  if (body.recruitmentId) {
    const exists = await db
      .selectFrom('sc_campus_recruitment_user')
      .select('id')
      .where('user_id', '=', userId)
      .where('recruitment_id', '=', body.recruitmentId)
      .executeTakeFirst();
    if (exists) throw new AppError(409, '您已投递过该职位');
  }
  const id = randomUUID().replaceAll('-', '');
  await db
    .insertInto('sc_campus_recruitment_user')
    .values({
      ...toRecruitmentInsert(body, id),
      user_id: userId,
      recruitment_id: body.recruitmentId ?? null,
      recruitment_status: body.recruitmentStatus ?? null,
      recruitment_remarks: body.recruitmentRemarks ?? null,
    } as any)
    .execute();
  return ok(id);
}

async function updateUserRecord(
  db: Kysely<Database>,
  userId: string,
  id: string,
  body: CampusBody,
  customOnly = false,
) {
  const existing = await db
    .selectFrom('sc_campus_recruitment_user')
    .selectAll()
    .where('id', '=', id)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!existing || (customOnly && existing.recruitment_id))
    throw new AppError(404, '记录不存在或无权操作');
  const patch: Record<string, unknown> = { update_time: new Date() };
  const filled = (value: unknown) => (typeof value === 'string' ? value.trim() !== '' : value != null);
  // System rows only accept status and remarks. Custom rows accept the detail fields.
  if (!existing.recruitment_id) {
    for (const [key, column] of [
      ['company', 'company'],
      ['positions', 'positions'],
      ['title', 'title'],
      ['workLocation', 'work_location'],
      ['industry', 'industry'],
      ['referralCode', 'referral_code'],
      ['referralMethod', 'referral_method'],
      ['progressCheck', 'progress_check'],
      ['remarks', 'remarks'],
      ['mainBusiness', 'main_business'],
      ['infoType', 'info_type'],
      ['expirationTime', 'expiration_time'],
    ] as const)
      if (filled((body as any)[key])) patch[column] = (body as any)[key];
  }
  if (filled(body.recruitmentStatus)) patch.recruitment_status = body.recruitmentStatus;
  if (filled(body.recruitmentRemarks)) patch.recruitment_remarks = body.recruitmentRemarks;
  const recordTime = (body as { recordTime?: unknown }).recordTime ?? body.record_time;
  if (typeof recordTime === 'string' && recordTime.trim()) {
    const applicationDate = parseApplicationDate(recordTime);
    if (!applicationDate) throw new AppError(400, '投递时间无效');
    patch.record_time = applicationDate;
  }
  await db
    .updateTable('sc_campus_recruitment_user')
    .set(patch as any)
    .where('id', '=', id)
    .execute();
  return ok(null);
}
