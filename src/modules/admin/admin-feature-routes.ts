import { randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import ExcelJS from 'exceljs';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { AppError } from '@/common/errors.js';
import { ok } from '@/common/http-response.js';
import type { AppEnv } from '@/config/env.js';
import type { Database } from '@/infrastructure/database.js';
import { requireAdmin } from '@/modules/admin/admin-auth-routes.js';
import { adminPage, idsFrom, nextAdminId, pageArgs, queryText } from '@/modules/admin/admin-crud.js';

type Query = Record<string, unknown>;

function boolQuery(value: unknown): boolean | null {
  const text = queryText(value).toLowerCase();
  if (text === 'true' || text === '1') return true;
  if (text === 'false' || text === '0') return false;
  return null;
}

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function likeFilter(column: RawBuilder<unknown>, value: unknown) {
  const text = queryText(value);
  return text ? sql`AND ${column} LIKE ${`%${text}%`}` : sql``;
}

function eqFilter(column: RawBuilder<unknown>, value: unknown) {
  const text = queryText(value);
  return text ? sql`AND ${column} = ${text}` : sql``;
}

function geFilter(column: RawBuilder<unknown>, value: unknown) {
  const text = queryText(value);
  return text ? sql`AND ${column} >= ${text}` : sql``;
}

function leFilter(column: RawBuilder<unknown>, value: unknown) {
  const text = queryText(value);
  return text ? sql`AND ${column} <= ${text}` : sql``;
}

export function registerAdminFeatureRoutes(app: FastifyInstance, env: AppEnv, db: Kysely<Database>) {
  const adminGuard = requireAdmin(env, db);
  void env;

  app.get<{ Querystring: Query }>('/app/redeemcode/page', { preHandler: adminGuard }, async (request) => {
    const { current, size, offset } = pageArgs(request.query);
    const where = redeemWhere(request.query);
    const count = await sql<{ total: number | string }>`
      SELECT COUNT(*) AS total
      FROM t_redeem_code rc
      ${where}
    `.execute(db);
    const rows = await sql<Record<string, unknown>>`
      SELECT ${redeemSelect()}
      FROM t_redeem_code rc
      LEFT JOIN sc_member_package mp ON rc.member_package_id = mp.id AND mp.delete_flag = 'NOT_DELETE'
      ${where}
      ORDER BY rc.create_time DESC
      LIMIT ${sql.raw(String(size))} OFFSET ${sql.raw(String(offset))}
    `.execute(db);
    return ok(adminPage(rows.rows.map(redeemRow), numberValue(count.rows[0]?.total), current, size));
  });

  app.post<{ Body: Record<string, unknown> }>('/app/redeemcode/add', { preHandler: adminGuard }, async (request) => {
    const body = request.body ?? {};
    const code = queryText(body.code);
    if (!code) throw new AppError(400, '兑换码不能为空');
    await assertUser(db, queryText(body.userId));
    const exists = await sql<{ total: number }>`SELECT COUNT(*) AS total FROM t_redeem_code WHERE code = ${code}`.execute(db);
    if (numberValue(exists.rows[0]?.total) > 0) throw new AppError(400, '兑换码已存在，请更换');
    await insertRedeem(db, { ...body, code, codeId: nextAdminId(), currentRedemption: body.currentRedemption ?? 0 });
    return ok(null);
  });

  app.post<{ Body: Record<string, unknown> }>('/app/redeemcode/edit', { preHandler: adminGuard }, async (request) => {
    const body = request.body ?? {};
    const codeId = queryText(body.codeId);
    if (!codeId) throw new AppError(400, '缺少主键');
    await sql`
      UPDATE t_redeem_code
      SET code = ${queryText(body.code)},
          code_type = ${queryText(body.codeType) || null},
          user_id = ${queryText(body.userId) || null},
          expiration_time = ${queryText(body.expirationTime) || null},
          rebate_rate = ${body.rebateRate ?? null},
          max_redemption = ${body.maxRedemption ?? null},
          current_redemption = ${body.currentRedemption ?? 0},
          member_package_id = ${queryText(body.memberPackageId) || null},
          ext_json = ${body.extJson == null ? null : String(body.extJson)},
          update_time = NOW()
      WHERE code_id = ${codeId} AND delete_flag = 'NOT_DELETE'
    `.execute(db);
    return ok(null);
  });

  app.post('/app/redeemcode/delete', { preHandler: adminGuard }, async (request) => {
    const ids = idsFrom(request.body, 'codeId');
    if (ids.length === 0) throw new AppError(400, '集合不能为空');
    await sql`
      UPDATE t_redeem_code SET delete_flag = 'DELETED'
      WHERE code_id IN (${sql.join(ids.map((id) => sql`${id}`))})
    `.execute(db);
    return ok(null);
  });

  app.post<{ Body: Record<string, unknown> }>('/app/redeemcode/batchAdd', { preHandler: adminGuard }, async (request) => {
    const body = request.body ?? {};
    const count = Number(body.createCount);
    const length = Number(body.codeLength ?? 12);
    if (!Number.isInteger(count) || count < 1 || count > 1000) throw new AppError(400, '创建数量范围是 1 到 1000');
    if (!Number.isInteger(length) || length < 6 || length > 20) throw new AppError(400, '兑换码长度范围是 6 到 20');
    await assertUser(db, queryText(body.userId));
    const codes: string[] = [];
    const used = new Set<string>();
    for (let index = 0; index < count; index += 1) {
      const code = await uniqueCode(db, length, used);
      used.add(code);
      codes.push(code);
      await insertRedeem(db, {
        codeId: nextAdminId(),
        code,
        codeType: body.codeType,
        userId: body.userId,
        expirationTime: body.expirationTime,
        rebateRate: body.rebateRate,
        maxRedemption: body.maxRedemption,
        currentRedemption: body.currentRedemption ?? 0,
        memberPackageId: body.memberPackageId,
        extJson: body.extJson,
      });
    }
    return ok(codes);
  });

  app.get<{ Querystring: Query }>('/app/redeemcode/export', { preHandler: adminGuard }, async (request, reply) => {
    const rows = await sql<Record<string, unknown>>`
      SELECT ${redeemSelect()}
      FROM t_redeem_code rc
      LEFT JOIN sc_member_package mp ON rc.member_package_id = mp.id AND mp.delete_flag = 'NOT_DELETE'
      ${redeemWhere(request.query)}
      ORDER BY rc.create_time DESC
    `.execute(db);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('兑换码');
    sheet.addRow(['兑换码', '折扣力度', '绑定套餐', '过期时间', '返佣比例', '最大兑换人数', '已兑换人数', '状态', '用户ID', '创建时间']);
    for (const row of rows.rows.map(redeemRow)) {
      const discount = discountText(row.extJson);
      const packageName = row.packageName
        ? row.packageExtJson
          ? `${row.packageExtJson}-${row.packageName}`
          : String(row.packageName)
        : '未绑定';
      sheet.addRow([
        row.code,
        discount,
        packageName,
        formatDate(row.expirationTime),
        row.rebateRate,
        row.maxRedemption,
        row.currentRedemption,
        row.isInvalid ? row.invalidReason : '有效',
        row.userId,
        formatDate(row.createTime),
      ]);
    }
    const buffer = await workbook.xlsx.writeBuffer();
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="redeem-codes.xlsx"`)
      .send(Buffer.from(buffer));
  });

  registerPhotoRoutes(app, db, adminGuard);
  registerOptimizeRoutes(app, db, adminGuard);
  registerCampusImport(app, db, adminGuard);
  registerEducationExtract(app, db, adminGuard);
}

function redeemSelect() {
  return sql`
    rc.code_id AS codeId,
    rc.code AS code,
    rc.code_type AS codeType,
    rc.expiration_time AS expirationTime,
    rc.max_redemption AS maxRedemption,
    rc.current_redemption AS currentRedemption,
    rc.delete_flag AS deleteFlag,
    rc.create_time AS createTime,
    rc.update_time AS updateTime,
    rc.ext_json AS extJson,
    rc.user_id AS userId,
    rc.rebate_rate AS rebateRate,
    rc.member_package_id AS memberPackageId,
    mp.package_name AS packageName,
    mp.current_amount AS currentAmount,
    mp.original_amount AS originalAmount,
    mp.ext_json AS packageExtJson
  `;
}

function redeemWhere(query: Query) {
  const hasPackage = boolQuery(query.hasPackage);
  const expired = boolQuery(query.isExpired);
  return sql`
    WHERE rc.delete_flag = 'NOT_DELETE'
    ${geFilter(sql`rc.expiration_time`, query.startExpirationTime)}
    ${leFilter(sql`rc.expiration_time`, query.endExpirationTime)}
    ${geFilter(sql`rc.create_time`, query.startCreateTime)}
    ${leFilter(sql`rc.create_time`, query.endCreateTime)}
    ${likeFilter(sql`rc.code`, query.code)}
    ${eqFilter(sql`rc.user_id`, query.userId)}
    ${
      hasPackage == null
        ? sql``
        : hasPackage
          ? sql`AND rc.member_package_id IS NOT NULL AND rc.member_package_id != ''`
          : sql`AND (rc.member_package_id IS NULL OR rc.member_package_id = '')`
    }
    ${
      expired == null
        ? sql``
        : expired
          ? sql`AND (rc.expiration_time < NOW() OR rc.current_redemption >= rc.max_redemption)`
          : sql`AND rc.expiration_time >= NOW() AND rc.current_redemption < rc.max_redemption`
    }
  `;
}

function redeemRow(row: Record<string, unknown>): Record<string, unknown> {
  const expiration = row.expirationTime instanceof Date ? row.expirationTime : row.expirationTime ? new Date(String(row.expirationTime)) : null;
  const current = numberValue(row.currentRedemption);
  const max = numberValue(row.maxRedemption);
  let isInvalid = false;
  let invalidReason: string | null = null;
  if (expiration && !Number.isNaN(expiration.getTime()) && expiration.getTime() < Date.now()) {
    isInvalid = true;
    invalidReason = '已过期';
  } else if (max > 0 && current >= max) {
    isInvalid = true;
    invalidReason = '兑换完毕';
  }
  return { ...row, isInvalid, invalidReason };
}

function discountText(value: unknown) {
  const rate = Number(value);
  if (!Number.isFinite(rate)) return '-';
  return `${Math.round(rate * 100)}%`;
}

function formatDate(value: unknown) {
  if (value instanceof Date) return value.toISOString().slice(0, 19).replace('T', ' ');
  return value == null ? '' : String(value);
}

async function assertUser(db: Kysely<Database>, userId: string) {
  if (!userId) return;
  const found = await sql<{ total: number }>`
    SELECT COUNT(*) AS total FROM client_user WHERE id = ${userId} AND DELETE_FLAG = 'NOT_DELETE'
  `.execute(db);
  if (numberValue(found.rows[0]?.total) === 0) throw new AppError(400, '用户不存在');
}

async function insertRedeem(db: Kysely<Database>, body: Record<string, unknown>) {
  await sql`
    INSERT INTO t_redeem_code (
      code_id, code, code_type, user_id, expiration_time, rebate_rate, max_redemption,
      current_redemption, member_package_id, ext_json, delete_flag, create_time
    ) VALUES (
      ${queryText(body.codeId)},
      ${queryText(body.code)},
      ${queryText(body.codeType) || null},
      ${queryText(body.userId) || null},
      ${queryText(body.expirationTime) || null},
      ${body.rebateRate ?? null},
      ${body.maxRedemption ?? null},
      ${body.currentRedemption ?? 0},
      ${queryText(body.memberPackageId) || null},
      ${body.extJson == null || body.extJson === '' ? null : String(body.extJson)},
      'NOT_DELETE',
      NOW()
    )
  `.execute(db);
}

async function uniqueCode(db: Kysely<Database>, length: number, used: Set<string>) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let code = '';
    for (let index = 0; index < length; index += 1) code += alphabet[randomInt(alphabet.length)];
    if (used.has(code)) continue;
    const exists = await sql<{ total: number }>`SELECT COUNT(*) AS total FROM t_redeem_code WHERE code = ${code}`.execute(db);
    if (numberValue(exists.rows[0]?.total) === 0) return code;
  }
  return randomInt(36 ** 8).toString(36).toUpperCase().padStart(length, '0').slice(0, length);
}

function registerPhotoRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  adminGuard: (request: FastifyRequest) => Promise<void>,
) {
  app.get<{ Querystring: Query }>('/app/photo/generation/page', { preHandler: adminGuard }, async (request) => {
    const { current, size, offset } = pageArgs(request.query);
    const where = photoWhere(request.query);
    const count = await sql<{ total: number | string }>`
      SELECT COUNT(*) AS total
      FROM sc_ai_photo_generation_record r
      LEFT JOIN client_user cu ON cu.id = r.user_id AND cu.delete_flag = 'NOT_DELETE'
      ${where}
    `.execute(db);
    const rows = await sql<Record<string, unknown>>`
      SELECT ${photoColumns()}
      FROM sc_ai_photo_generation_record r
      LEFT JOIN client_user cu ON cu.id = r.user_id AND cu.delete_flag = 'NOT_DELETE'
      ${where}
      ORDER BY r.create_time DESC
      LIMIT ${sql.raw(String(size))} OFFSET ${sql.raw(String(offset))}
    `.execute(db);
    return ok(adminPage(rows.rows, numberValue(count.rows[0]?.total), current, size));
  });

  app.get<{ Querystring: Query }>('/app/photo/generation/detail', { preHandler: adminGuard }, async (request) => {
    const id = queryText(request.query.id);
    if (!id) throw new AppError(400, '缺少主键');
    const row = await sql<Record<string, unknown>>`
      SELECT ${photoColumns()}
      FROM sc_ai_photo_generation_record r
      LEFT JOIN client_user cu ON cu.id = r.user_id AND cu.delete_flag = 'NOT_DELETE'
      WHERE r.delete_flag = 'NOT_DELETE' AND r.id = ${id}
      LIMIT 1
    `.execute(db);
    if (!row.rows[0]) throw new AppError(404, '记录不存在');
    return ok(row.rows[0]);
  });

  app.get<{ Querystring: Query }>('/app/photo/generation/statistics', { preHandler: adminGuard }, async (request) => {
    const where = photoWhere(request.query);
    const row = await sql<Record<string, unknown>>`
      SELECT
        COUNT(1) AS totalCount,
        IFNULL(SUM(CASE WHEN r.status = 'SUCCESS' THEN 1 ELSE 0 END), 0) AS successCount,
        IFNULL(SUM(CASE WHEN r.status = 'FAILED' THEN 1 ELSE 0 END), 0) AS failedCount,
        IFNULL(SUM(CASE WHEN r.status = 'PROCESSING' THEN 1 ELSE 0 END), 0) AS processingCount,
        COUNT(DISTINCT r.user_id) AS userCount,
        IFNULL(ROUND(SUM(CASE WHEN r.status = 'SUCCESS' THEN 1 ELSE 0 END) * 100 / NULLIF(COUNT(1), 0), 2), 0) AS successRate,
        IFNULL(SUM(r.estimated_cost), 0) AS estimatedCost,
        IFNULL(SUM(r.cost_count), 0) AS costCount,
        IFNULL(AVG(CASE WHEN r.duration_ms IS NOT NULL AND r.duration_ms > 0 THEN r.duration_ms END), 0) AS averageDurationMs
      FROM sc_ai_photo_generation_record r
      LEFT JOIN client_user cu ON cu.id = r.user_id AND cu.delete_flag = 'NOT_DELETE'
      ${where}
    `.execute(db);
    return ok(numbers(row.rows[0] ?? {}));
  });

  app.post('/app/photo/generation/delete', { preHandler: adminGuard }, async (request) => {
    const ids = idsFrom(request.body, 'id');
    if (ids.length === 0) throw new AppError(400, '集合不能为空');
    await sql`
      UPDATE sc_ai_photo_generation_record SET delete_flag = 'DELETED'
      WHERE id IN (${sql.join(ids.map((id) => sql`${id}`))})
    `.execute(db);
    return ok(null);
  });

  app.get<{ Querystring: Query }>('/app/photo/member/page', { preHandler: adminGuard }, async (request) => {
    const { current, size, offset } = pageArgs(request.query);
    const search = queryText(request.query.searchKey);
    const searchSql = search
      ? sql`AND (cu.id LIKE ${`%${search}%`} OR cu.nickname LIKE ${`%${search}%`} OR cu.account LIKE ${`%${search}%`} OR cu.invitation_code LIKE ${`%${search}%`})`
      : sql``;
    const onlyPurchased = boolQuery(request.query.onlyPurchased) === true;
    const having = onlyPurchased ? sql`HAVING purchaseOrderCount > 0 OR manualAdjustRecordCount > 0` : sql``;
    const purchasedWhere = onlyPurchased
      ? sql`WHERE purchaseOrderCount > 0 OR manualAdjustRecordCount > 0`
      : sql``;
    const base = () => sql`
      FROM client_user cu
      LEFT JOIN sc_user_function_limits ufl ON ufl.user_id = cu.id AND ufl.function_name = 'AI证件照生成'
      LEFT JOIN t_recharge_record rr ON rr.user_id = cu.id AND rr.delete_flag = 'NOT_DELETE'
      LEFT JOIN sc_member_package mp ON mp.id = rr.membership_package_id AND mp.ext_json = 'AI证件照' AND mp.billing_mode = 'COUNT_PACKAGE'
      LEFT JOIN (
        SELECT user_id, SUM(change_count) AS manual_adjust_count, COUNT(1) AS manual_adjust_record_count
        FROM sc_ai_photo_member_adjust_record
        WHERE delete_flag = 'NOT_DELETE'
        GROUP BY user_id
      ) ar ON ar.user_id = cu.id
      LEFT JOIN (
        SELECT lar_source.*
        FROM sc_ai_photo_member_adjust_record lar_source
        LEFT JOIN sc_ai_photo_member_adjust_record lar_later
          ON lar_later.user_id = lar_source.user_id
          AND lar_later.delete_flag = 'NOT_DELETE'
          AND (lar_later.create_time > lar_source.create_time OR (lar_later.create_time = lar_source.create_time AND lar_later.id > lar_source.id))
        WHERE lar_source.delete_flag = 'NOT_DELETE' AND lar_later.id IS NULL
      ) lar ON lar.user_id = cu.id
      WHERE cu.delete_flag = 'NOT_DELETE'
      ${searchSql}
    `;
    const count = await sql<{ total: number | string }>`
      SELECT COUNT(*) AS total FROM (
        SELECT
          IFNULL(SUM(CASE WHEN mp.id IS NOT NULL THEN 1 ELSE 0 END), 0) AS purchaseOrderCount,
          IFNULL(MAX(ar.manual_adjust_record_count), 0) AS manualAdjustRecordCount
        ${base()}
        GROUP BY cu.id
      ) member_page
      ${purchasedWhere}
    `.execute(db);
    const rows = await sql<Record<string, unknown>>`
      SELECT
        cu.id AS userId,
        MAX(cu.nickname) AS nickname,
        MAX(cu.avatar) AS avatar,
        MAX(cu.account) AS account,
        MAX(cu.invitation_code) AS invitationCode,
        MAX(cu.create_time) AS userCreateTime,
        IFNULL(MAX(ufl.remaining_uses), 0) AS remainingUses,
        IFNULL(SUM(CASE WHEN mp.id IS NOT NULL THEN mp.usage_count ELSE 0 END), 0) AS totalPurchasedCount,
        IFNULL(SUM(CASE WHEN mp.id IS NOT NULL THEN rr.amount ELSE 0 END), 0) / 100 AS totalPaidAmount,
        IFNULL(SUM(CASE WHEN mp.id IS NOT NULL THEN 1 ELSE 0 END), 0) AS purchaseOrderCount,
        SUBSTRING_INDEX(GROUP_CONCAT(CASE WHEN mp.id IS NOT NULL THEN rr.package_name END ORDER BY rr.create_time DESC SEPARATOR '||'), '||', 1) AS lastPackageName,
        CAST(SUBSTRING_INDEX(GROUP_CONCAT(CASE WHEN mp.id IS NOT NULL THEN mp.usage_count END ORDER BY rr.create_time DESC SEPARATOR ','), ',', 1) AS SIGNED) AS lastPackageUsageCount,
        MAX(CASE WHEN mp.id IS NOT NULL THEN rr.create_time END) AS lastPayTime,
        IFNULL(MAX(ar.manual_adjust_count), 0) AS manualAdjustCount,
        IFNULL(MAX(ar.manual_adjust_record_count), 0) AS manualAdjustRecordCount,
        MAX(lar.adjust_type) AS lastManualAdjustType,
        MAX(lar.change_count) AS lastManualChangeCount,
        MAX(lar.after_count) AS lastManualAfterCount,
        MAX(lar.remark) AS lastManualRemark,
        MAX(lar.operator_name) AS lastManualOperatorName,
        MAX(lar.create_time) AS lastManualAdjustTime
      ${base()}
      GROUP BY cu.id
      ${having}
      ORDER BY GREATEST(IFNULL(MAX(CASE WHEN mp.id IS NOT NULL THEN rr.create_time END), '1970-01-01'), IFNULL(MAX(lar.create_time), '1970-01-01')) DESC,
        IFNULL(MAX(ufl.remaining_uses), 0) DESC,
        MAX(cu.create_time) DESC
      LIMIT ${sql.raw(String(size))} OFFSET ${sql.raw(String(offset))}
    `.execute(db);
    return ok(adminPage(rows.rows, numberValue(count.rows[0]?.total), current, size));
  });

  app.post<{ Body: Record<string, unknown> }>('/app/photo/member/adjust', { preHandler: adminGuard }, async (request) => {
    const body = request.body ?? {};
    const userId = queryText(body.userId);
    await assertUser(db, userId);
    const adjustType = queryText(body.adjustType).toUpperCase();
    const before = await photoCount(db, userId);
    let after = before;
    let change = 0;
    if (adjustType === 'ADD') {
      change = Number(body.changeCount);
      if (!Number.isInteger(change) || change <= 0) throw new AppError(400, '增加次数必须大于0');
      after = before + change;
    } else if (adjustType === 'SET') {
      after = Number(body.targetRemainingUses);
      if (!Number.isInteger(after) || after < 0) throw new AppError(400, '目标剩余次数不能小于0');
      change = after - before;
    } else {
      throw new AppError(400, '调整类型不正确');
    }
    await setPhotoCount(db, userId, after);
    const operator = await sql<{ NAME: string | null; ACCOUNT: string | null }>`
      SELECT NAME, ACCOUNT FROM sys_user WHERE ID = ${request.adminId ?? ''} LIMIT 1
    `.execute(db);
    const operatorName = operator.rows[0]?.NAME || operator.rows[0]?.ACCOUNT || null;
    await sql`
      INSERT INTO sc_ai_photo_member_adjust_record (
        id, user_id, adjust_type, before_count, change_count, after_count, operator_id, operator_name, remark, delete_flag, create_time
      ) VALUES (
        ${nextAdminId()}, ${userId}, ${adjustType}, ${before}, ${change}, ${after},
        ${request.adminId ?? null}, ${operatorName}, ${queryText(body.remark) || null}, 'NOT_DELETE', NOW()
      )
    `.execute(db);
    return ok(null);
  });

  app.get<{ Querystring: Query }>('/app/photo/member/adjustRecord/page', { preHandler: adminGuard }, async (request) => {
    const userId = queryText(request.query.userId);
    if (!userId) throw new AppError(400, '用户ID不能为空');
    const { current, size, offset } = pageArgs(request.query);
    const count = await sql<{ total: number | string }>`
      SELECT COUNT(*) AS total FROM sc_ai_photo_member_adjust_record
      WHERE delete_flag = 'NOT_DELETE' AND user_id = ${userId}
    `.execute(db);
    const rows = await sql<Record<string, unknown>>`
      SELECT id, user_id AS userId, adjust_type AS adjustType, before_count AS beforeCount,
        change_count AS changeCount, after_count AS afterCount, operator_id AS operatorId,
        operator_name AS operatorName, remark, create_time AS createTime
      FROM sc_ai_photo_member_adjust_record
      WHERE delete_flag = 'NOT_DELETE' AND user_id = ${userId}
      ORDER BY create_time DESC
      LIMIT ${sql.raw(String(size))} OFFSET ${sql.raw(String(offset))}
    `.execute(db);
    return ok(adminPage(rows.rows, numberValue(count.rows[0]?.total), current, size));
  });
}

function photoColumns() {
  return sql`
    r.id, r.delete_flag AS deleteFlag, r.create_time AS createTime, r.update_time AS updateTime,
    r.user_id AS userId, r.source_image_url AS sourceImageUrl, r.result_image_url AS resultImageUrl,
    r.size_id AS sizeId, r.size_name AS sizeName, r.width, r.height,
    r.background_color AS backgroundColor, r.background_hex AS backgroundHex,
    r.template_id AS templateId, r.template_name AS templateName, r.gender, r.status,
    r.error_message AS errorMessage, r.provider, r.model_id AS modelId,
    r.duration_ms AS durationMs, r.estimated_cost AS estimatedCost, r.billing_mode AS billingMode,
    r.cost_count AS costCount, r.member_snapshot AS memberSnapshot,
    cu.nickname AS userNickname, cu.account AS userAccount, cu.phone AS userPhone
  `;
}

function photoWhere(query: Query) {
  return sql`
    WHERE r.delete_flag = 'NOT_DELETE'
    ${eqFilter(sql`r.user_id`, query.userId)}
    ${likeFilter(sql`cu.nickname`, query.userNickname)}
    ${eqFilter(sql`r.status`, query.status)}
    ${eqFilter(sql`r.size_id`, query.sizeId)}
    ${eqFilter(sql`r.background_color`, query.backgroundColor)}
    ${eqFilter(sql`r.template_id`, query.templateId)}
    ${geFilter(sql`r.create_time`, query.startTime)}
    ${leFilter(sql`r.create_time`, query.endTime)}
  `;
}

async function photoCount(db: Kysely<Database>, userId: string) {
  const row = await sql<{ remaining: number | null }>`
    SELECT remaining_uses AS remaining FROM sc_user_function_limits
    WHERE user_id = ${userId} AND function_name = 'AI证件照生成'
    LIMIT 1
  `.execute(db);
  return numberValue(row.rows[0]?.remaining);
}

async function setPhotoCount(db: Kysely<Database>, userId: string, count: number) {
  const updated = await sql`
    UPDATE sc_user_function_limits SET remaining_uses = ${count}, update_time = NOW()
    WHERE user_id = ${userId} AND function_name = 'AI证件照生成'
  `.execute(db);
  if (Number(updated.numAffectedRows ?? 0) > 0) return;
  await sql`
    INSERT INTO sc_user_function_limits (id, function_name, remaining_uses, user_id, create_time)
    VALUES (${nextAdminId()}, 'AI证件照生成', ${count}, ${userId}, NOW())
  `.execute(db);
}

function numbers(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, numberValue(value)]));
}

function registerOptimizeRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  adminGuard: (request: FastifyRequest) => Promise<void>,
) {
  app.get<{ Querystring: Query }>('/app/resume/ai/optimize/page', { preHandler: adminGuard }, async (request) => {
    const { current, size, offset } = pageArgs(request.query);
    const where = optimizeWhere(request.query);
    const count = await sql<{ total: number | string }>`
      SELECT COUNT(*) AS total
      FROM sc_resume_ai_optimize_record r
      LEFT JOIN client_user cu ON cu.id = r.user_id AND cu.delete_flag = 'NOT_DELETE'
      ${where}
    `.execute(db);
    const rows = await sql<Record<string, unknown>>`
      SELECT ${optimizeColumns()}
      FROM sc_resume_ai_optimize_record r
      LEFT JOIN client_user cu ON cu.id = r.user_id AND cu.delete_flag = 'NOT_DELETE'
      ${where}
      ORDER BY r.create_time DESC
      LIMIT ${sql.raw(String(size))} OFFSET ${sql.raw(String(offset))}
    `.execute(db);
    return ok(adminPage(rows.rows, numberValue(count.rows[0]?.total), current, size));
  });

  app.get<{ Querystring: Query }>('/app/resume/ai/optimize/detail', { preHandler: adminGuard }, async (request) => {
    const id = queryText(request.query.id);
    if (!id) throw new AppError(400, '缺少主键');
    const row = await sql<Record<string, unknown>>`
      SELECT ${optimizeColumns()}
      FROM sc_resume_ai_optimize_record r
      LEFT JOIN client_user cu ON cu.id = r.user_id AND cu.delete_flag = 'NOT_DELETE'
      WHERE r.delete_flag = 'NOT_DELETE' AND r.id = ${id}
      LIMIT 1
    `.execute(db);
    if (!row.rows[0]) throw new AppError(404, '记录不存在');
    return ok(row.rows[0]);
  });

  app.get<{ Querystring: Query }>('/app/resume/ai/optimize/statistics', { preHandler: adminGuard }, async (request) => {
    const row = await sql<Record<string, unknown>>`
      SELECT
        COUNT(1) AS totalCount,
        IFNULL(SUM(CASE WHEN r.status = 'SUCCESS' THEN 1 ELSE 0 END), 0) AS successCount,
        IFNULL(SUM(CASE WHEN r.status = 'FAILED' THEN 1 ELSE 0 END), 0) AS failedCount,
        IFNULL(SUM(CASE WHEN r.status = 'REJECTED' THEN 1 ELSE 0 END), 0) AS rejectedCount,
        IFNULL(SUM(CASE WHEN r.status = 'PROCESSING' THEN 1 ELSE 0 END), 0) AS processingCount,
        COUNT(DISTINCT r.user_id) AS userCount,
        IFNULL(ROUND(SUM(CASE WHEN r.status = 'SUCCESS' THEN 1 ELSE 0 END) * 100 / NULLIF(COUNT(1), 0), 2), 0) AS successRate,
        IFNULL(SUM(r.prompt_tokens), 0) AS totalPromptTokens,
        IFNULL(SUM(r.completion_tokens), 0) AS totalCompletionTokens,
        IFNULL(SUM(r.total_tokens), 0) AS totalTokens,
        IFNULL(SUM(r.estimated_cost), 0) AS totalEstimatedCost,
        IFNULL(AVG(CASE WHEN r.duration_ms IS NOT NULL AND r.duration_ms > 0 THEN r.duration_ms END), 0) AS averageDurationMs
      FROM sc_resume_ai_optimize_record r
      LEFT JOIN client_user cu ON cu.id = r.user_id AND cu.delete_flag = 'NOT_DELETE'
      ${optimizeWhere(request.query)}
    `.execute(db);
    return ok(numbers(row.rows[0] ?? {}));
  });

  app.get<{ Querystring: Query }>('/app/resume/ai/optimize/user/page', { preHandler: adminGuard }, async (request) => {
    const { current, size, offset } = pageArgs(request.query);
    const exceed = boolQuery(request.query.costExceedRecharge);
    const having = exceed == null ? sql`` : sql`HAVING costExceedRecharge = ${exceed ? 1 : 0}`;
    const timeStart = queryText(request.query.lastOptimizeTimeStart);
    const timeEnd = queryText(request.query.lastOptimizeTimeEnd);
    const base = () => sql`
      FROM sc_resume_ai_optimize_record r
      LEFT JOIN client_user cu ON cu.id = r.user_id AND cu.delete_flag = 'NOT_DELETE'
      LEFT JOIN (
        SELECT rr.user_id, IFNULL(SUM(rr.amount), 0) AS total_recharge_amount
        FROM t_recharge_record rr
        LEFT JOIN sc_member_package mp ON mp.id = rr.membership_package_id
        WHERE rr.delete_flag = 'NOT_DELETE'
          AND (mp.id IS NULL OR mp.delete_flag = 'NOT_DELETE')
          AND (mp.ext_json IS NULL OR mp.ext_json != 'AI证件照')
        GROUP BY rr.user_id
      ) recharge ON recharge.user_id = r.user_id
      WHERE r.delete_flag = 'NOT_DELETE'
      ${eqFilter(sql`r.user_id`, request.query.userId)}
      ${likeFilter(sql`cu.nickname`, request.query.userNickname)}
      ${likeFilter(sql`cu.phone`, request.query.userPhone)}
      GROUP BY r.user_id
      ${having}
    `;
    const outerTime = () => sql`
      ${timeStart ? sql`WHERE lastOptimizeTime >= ${timeStart}` : sql``}
      ${timeEnd ? sql`${timeStart ? sql`AND` : sql`WHERE`} lastOptimizeTime <= ${timeEnd}` : sql``}
    `;
    const count = await sql<{ total: number | string }>`
      SELECT COUNT(*) AS total FROM (
        SELECT MAX(r.create_time) AS lastOptimizeTime,
          CASE WHEN IFNULL(SUM(r.estimated_cost), 0) > IFNULL(MAX(recharge.total_recharge_amount), 0) THEN 1 ELSE 0 END AS costExceedRecharge
        ${base()}
      ) summary
      ${outerTime()}
    `.execute(db);
    const rows = await sql<Record<string, unknown>>`
      SELECT * FROM (
        SELECT
          r.user_id AS userId,
          MAX(cu.nickname) AS userNickname,
          MAX(cu.account) AS userAccount,
          MAX(cu.phone) AS userPhone,
          MAX(cu.member_level) AS memberLevel,
          MAX(cu.member_expiration_time) AS memberExpirationTime,
          MAX(cu.offer_member_expiration_time) AS offerMemberExpirationTime,
          COUNT(1) AS totalOptimizeCount,
          IFNULL(SUM(r.prompt_tokens), 0) AS totalPromptTokens,
          IFNULL(SUM(r.completion_tokens), 0) AS totalCompletionTokens,
          IFNULL(SUM(r.total_tokens), 0) AS totalTokens,
          IFNULL(SUM(r.estimated_cost), 0) AS totalEstimatedCost,
          IFNULL(MAX(recharge.total_recharge_amount), 0) AS totalRechargeAmount,
          CASE WHEN IFNULL(SUM(r.estimated_cost), 0) > IFNULL(MAX(recharge.total_recharge_amount), 0) THEN 1 ELSE 0 END AS costExceedRecharge,
          MAX(r.create_time) AS lastOptimizeTime
        ${base()}
      ) summary
      ${outerTime()}
      ORDER BY lastOptimizeTime DESC
      LIMIT ${sql.raw(String(size))} OFFSET ${sql.raw(String(offset))}
    `.execute(db);
    return ok(adminPage(rows.rows.map(flagRow), numberValue(count.rows[0]?.total), current, size));
  });

  app.get<{ Querystring: Query }>('/app/resume/ai/optimize/user/detail', { preHandler: adminGuard }, async (request) => {
    const userId = queryText(request.query.userId);
    if (!userId) throw new AppError(400, '用户ID不能为空');
    const row = await sql<Record<string, unknown>>`
      SELECT
        r.user_id AS userId,
        MAX(cu.nickname) AS userNickname,
        MAX(cu.account) AS userAccount,
        MAX(cu.phone) AS userPhone,
        MAX(cu.member_level) AS memberLevel,
        MAX(cu.member_expiration_time) AS memberExpirationTime,
        MAX(cu.offer_member_expiration_time) AS offerMemberExpirationTime,
        COUNT(1) AS totalOptimizeCount,
        IFNULL(SUM(r.prompt_tokens), 0) AS totalPromptTokens,
        IFNULL(SUM(r.completion_tokens), 0) AS totalCompletionTokens,
        IFNULL(SUM(r.total_tokens), 0) AS totalTokens,
        IFNULL(SUM(r.estimated_cost), 0) AS totalEstimatedCost,
        IFNULL(MAX(recharge.total_recharge_amount), 0) AS totalRechargeAmount,
        CASE WHEN IFNULL(SUM(r.estimated_cost), 0) > IFNULL(MAX(recharge.total_recharge_amount), 0) THEN 1 ELSE 0 END AS costExceedRecharge,
        MAX(r.create_time) AS lastOptimizeTime
      FROM sc_resume_ai_optimize_record r
      LEFT JOIN client_user cu ON cu.id = r.user_id AND cu.delete_flag = 'NOT_DELETE'
      LEFT JOIN (
        SELECT rr.user_id, IFNULL(SUM(rr.amount), 0) AS total_recharge_amount
        FROM t_recharge_record rr
        LEFT JOIN sc_member_package mp ON mp.id = rr.membership_package_id
        WHERE rr.delete_flag = 'NOT_DELETE'
          AND (mp.id IS NULL OR mp.delete_flag = 'NOT_DELETE')
          AND (mp.ext_json IS NULL OR mp.ext_json != 'AI证件照')
        GROUP BY rr.user_id
      ) recharge ON recharge.user_id = r.user_id
      WHERE r.delete_flag = 'NOT_DELETE' AND r.user_id = ${userId}
      GROUP BY r.user_id
    `.execute(db);
    if (!row.rows[0]) throw new AppError(404, '记录不存在');
    return ok(flagRow(row.rows[0]));
  });
}

function optimizeColumns() {
  return sql`
    r.id, r.create_time AS createTime, r.update_time AS updateTime, r.user_id AS userId,
    r.resume_id AS resumeId, r.module_id AS moduleId, r.scene, r.source_text AS sourceText,
    r.source_text_length AS sourceTextLength, r.user_instruction AS userInstruction,
    r.result_text AS resultText, r.result_html AS resultHtml, r.result_text_length AS resultTextLength,
    r.status, r.reject_reason AS rejectReason, r.error_code AS errorCode, r.error_message AS errorMessage,
    r.provider, r.model_id AS modelId, r.provider_request_id AS providerRequestId,
    r.prompt_template_code AS promptTemplateCode, r.prompt_template_version AS promptTemplateVersion,
    r.prompt_tokens AS promptTokens, r.completion_tokens AS completionTokens, r.total_tokens AS totalTokens,
    r.input_unit_price AS inputUnitPrice, r.output_unit_price AS outputUnitPrice,
    r.estimated_cost AS estimatedCost, r.duration_ms AS durationMs,
    r.member_level_snapshot AS memberLevelSnapshot,
    r.offer_member_expiration_snapshot AS offerMemberExpirationSnapshot, r.ext_json AS extJson,
    cu.nickname AS userNickname, cu.account AS userAccount, cu.phone AS userPhone,
    cu.member_level AS currentMemberLevel, cu.member_expiration_time AS currentMemberExpirationTime,
    cu.offer_member_expiration_time AS currentOfferMemberExpirationTime
  `;
}

function optimizeWhere(query: Query) {
  return sql`
    WHERE r.delete_flag = 'NOT_DELETE'
    ${eqFilter(sql`r.user_id`, query.userId)}
    ${likeFilter(sql`cu.nickname`, query.userNickname)}
    ${likeFilter(sql`cu.phone`, query.userPhone)}
    ${eqFilter(sql`r.scene`, query.scene)}
    ${eqFilter(sql`r.status`, query.status)}
    ${eqFilter(sql`r.provider`, query.provider)}
    ${eqFilter(sql`r.model_id`, query.modelId)}
    ${geFilter(sql`r.create_time`, query.startTime)}
    ${leFilter(sql`r.create_time`, query.endTime)}
  `;
}

function flagRow(row: Record<string, unknown>) {
  return { ...row, costExceedRecharge: numberValue(row.costExceedRecharge) === 1 };
}

function registerCampusImport(
  app: FastifyInstance,
  db: Kysely<Database>,
  adminGuard: (request: FastifyRequest) => Promise<void>,
) {
  app.post('/app/campusrecruitment/campus/import', { preHandler: adminGuard }, async (request) =>
    importCampus(db, request, '校招'),
  );
  app.post('/app/campusrecruitment/referral/import', { preHandler: adminGuard }, async (request) =>
    importCampus(db, request, '内推'),
  );
}

async function importCampus(db: Kysely<Database>, request: FastifyRequest, infoType: '校招' | '内推') {
  const part = await request.file();
  if (!part) throw new AppError(400, '请上传 Excel 文件');
  const buffer = await part.toBuffer();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheetName = infoType === '校招' ? '校招汇总' : '校招内推汇总';
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) throw new AppError(400, `Excel文件中未找到'${sheetName}'工作表`);
  const headerRowNumber = infoType === '校招' ? 1 : 2;
  const header = sheet.getRow(headerRowNumber);
  const columns = new Map<string, number>();
  header.eachCell((cell, index) => columns.set(cellText(cell.value), index));
  const required = infoType === '校招'
    ? ['⏰收录时间', '🏢公司', '官方标题', '推文/投递链接', '岗位', 'ddl', '地点', '行业', '企业性质']
    : ['公司', '内推码', '内推链接', '所属行业', '主营业务', '招聘岗位', '工作地点', '刷新时间'];
  const missing = required.filter((name) => !columns.has(name));
  if (missing.length) throw new AppError(400, `缺少列：${missing.join('、')}`);
  const latest = await sql<{ record_time: Date | null }>`
    SELECT record_time FROM sc_campus_recruitment
    WHERE info_type = ${infoType}
    ORDER BY record_time DESC
    LIMIT 1
  `.execute(db);
  const latestTime = latest.rows[0]?.record_time ?? null;
  const rows: Record<string, unknown>[] = [];
  for (let rowNumber = headerRowNumber + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const read = (name: string) => cellText(row.getCell(columns.get(name) ?? 1).value);
    const recordTime = parseWallClock(row.getCell(columns.get(infoType === '校招' ? '⏰收录时间' : '刷新时间') ?? 1).value);
    if (!recordTime) continue;
    if (latestTime && recordTime.getTime() <= latestTime.getTime()) break;
    const company = read(infoType === '校招' ? '🏢公司' : '公司');
    if (!company) continue;
    if (infoType === '内推' && !read('内推链接')) continue;
    rows.push(
      infoType === '校招'
        ? {
            recordTime,
            company,
            title: read('官方标题'),
            referralMethod: read('推文/投递链接'),
            positions: read('岗位'),
            expirationTime: read('ddl'),
            workLocation: read('地点'),
            industry: read('行业'),
            remarks: read('企业性质'),
          }
        : {
            recordTime,
            company,
            referralMethod: read('内推链接'),
            positions: read('招聘岗位'),
            workLocation: read('工作地点'),
            industry: read('所属行业'),
            mainBusiness: read('主营业务'),
            referralCode: read('内推码'),
          },
    );
  }
  if (rows.length === 0) throw new AppError(400, '未找到有效数据');
  for (const row of rows) {
    await sql`
      INSERT INTO sc_campus_recruitment (
        id, create_time, record_time, expiration_time, company, referral_code, referral_method,
        title, work_location, industry, positions, remarks, main_business, info_type
      ) VALUES (
        ${nextAdminId()}, NOW(), ${row.recordTime ?? null}, ${queryText(row.expirationTime) || null},
        ${queryText(row.company)}, ${queryText(row.referralCode) || null}, ${queryText(row.referralMethod) || null},
        ${queryText(row.title) || null}, ${queryText(row.workLocation) || null}, ${queryText(row.industry) || null},
        ${queryText(row.positions) || null}, ${queryText(row.remarks) || null}, ${queryText(row.mainBusiness) || null},
        ${infoType}
      )
    `.execute(db);
  }
  return ok(`成功导入 ${rows.length} 条数据`);
}

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return '';
  if (value instanceof Date) return formatDate(parseExcelDate(value));
  if (typeof value === 'object' && 'richText' in value) return value.richText.map((item) => item.text).join('').trim();
  if (typeof value === 'object' && 'text' in value) return String(value.text).trim();
  if (typeof value === 'object' && 'result' in value) return cellText(value.result as ExcelJS.CellValue);
  return String(value).trim();
}

function parseExcelDate(value: Date) {
  const text = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(value);
  return new Date(`${text.replace(' ', 'T')}Z`);
}

function parseWallClock(value: ExcelJS.CellValue): Date | null {
  if (value instanceof Date) return parseExcelDate(value);
  const text = cellText(value).replace(/\//g, '-').replace('T', ' ');
  if (!text) return null;
  const normalized = text.length === 10 ? `${text} 00:00:00` : text.length === 16 ? `${text}:00` : text;
  const date = new Date(`${normalized.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

const DEGREE_RANK = ['博士', '硕士', '研究生', '本科', '学士', '大专', '专科', '高中', '中专'];

function registerEducationExtract(
  app: FastifyInstance,
  db: Kysely<Database>,
  adminGuard: (request: FastifyRequest) => Promise<void>,
) {
  app.get('/client/user/education/extractAll', { preHandler: adminGuard }, async () => {
    const rows = await sql<{ userId: string; content: string | null }>`
      SELECT r.user_id AS userId, m.module_content AS content
      FROM sc_resume_modules m
      INNER JOIN sc_resume r ON r.id = m.resume_id
      WHERE m.module_type = '教育经历'
        AND (m.delete_flag = 'NOT_DELETE' OR m.delete_flag IS NULL)
    `.execute(db);
    const grouped = new Map<string, string[]>();
    for (const row of rows.rows) {
      const list = grouped.get(row.userId) ?? [];
      if (row.content) list.push(row.content);
      grouped.set(row.userId, list);
    }
    let success = 0;
    for (const [userId, contents] of grouped) {
      const education = pickEducation(contents);
      if (!education) continue;
      await sql`
        UPDATE client_user
        SET highest_education = ${education.degree},
            latest_school = ${education.school},
            latest_profession = ${education.profession}
        WHERE id = ${userId}
      `.execute(db);
      success += 1;
    }
    return ok({ code: 200, message: `批量学历提取完成，成功处理${success}个用户` });
  });
}

function pickEducation(contents: string[]) {
  const items: Array<{ school: string; profession: string; degree: string; end: string; rank: number }> = [];
  for (const content of contents) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      continue;
    }
    const list = Array.isArray(parsed) ? parsed : [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const degree = queryText(record.degree || record.education);
      const school = queryText(record.school || record.schoolName);
      const profession = queryText(record.profession || record.major);
      if (!degree && !school && !profession) continue;
      const rank = DEGREE_RANK.findIndex((name) => degree.includes(name));
      items.push({ school, profession, degree, end: queryText(record.endTime), rank: rank === -1 ? 99 : rank });
    }
  }
  items.sort((left, right) => left.rank - right.rank || right.end.localeCompare(left.end));
  return items[0] ?? null;
}
