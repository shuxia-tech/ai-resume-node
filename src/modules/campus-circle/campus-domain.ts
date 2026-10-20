import type { FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { uploadToCos } from '@/modules/storage/cos-service.js';
import {
  AMBASSADOR,
  AMBASSADOR_RECRUIT,
  APPROVED,
  AVATAR_IMAGE,
  AVATAR_TYPES,
  BRAND,
  CANCEL_VIP,
  CLUB,
  FILE_AVATAR,
  FILE_PROJECT,
  FILE_SCENES,
  FILE_VERIFICATION,
  GRANT_VIP,
  HIDE,
  PASS,
  PENDING,
  PIN,
  PROFILE,
  PROFILE_OPERATIONS,
  PROJECT,
  PROJECT_OPERATIONS,
  PROJECT_TYPES,
  REJECT,
  RATING,
  REJECTED,
  REVOKE,
  ROLE_TYPES,
  SET_TAGS,
  SHOW,
  SPONSOR,
  TAG_BUSINESS,
  TAG_OPERATION,
  TAG_SPONSOR_NEED,
  TAG_TEAM,
  TAG_WORK,
  UNPIN,
  VERIFICATION,
  VERIFICATION_REVIEW_ACTIONS,
  asDate,
  CampusError,
  campus,
  cellNumber,
  cellText,
  executeAffected,
  flag,
  insertRow,
  intValue,
  isVipActive,
  limitLength,
  limitList,
  newId,
  optionalText,
  pageQuery,
  pageResult,
  queryCount,
  queryOne,
  queryRows,
  ratingAverage,
  recordReview,
  recordSensitive,
  requireBound,
  sha256,
  shanghaiDay,
  shanghaiStart,
  sm4Decrypt,
  sm4Encrypt,
  stamp,
  stringList,
  text,
  withLock,
  type CampusDb,
  type Row,
} from '@/modules/campus-circle/campus-support.js';
import type { AppEnv } from '@/config/env.js';

const DAILY_UNLOCK_LIMIT = 3;
const CONTENT_ID = 'cc-platform-content';
function latestVerificationFilter() {
  return sql`id IN (
    SELECT latest.id FROM sc_campus_verification latest
    LEFT JOIN sc_campus_verification newer
      ON newer.user_id = latest.user_id AND newer.version_no > latest.version_no
    WHERE newer.id IS NULL
  )`;
}

function alive(table: string) {
  return sql`${sql.raw(table)}.delete_flag = 'NOT_DELETE'`;
}

async function tagsByRevision(db: CampusDb, revisionIds: string[]) {
  if (revisionIds.length === 0) return new Map<string, Row[]>();
  const rows = await queryRows(
    db,
    sql`SELECT revision_id, tag_type, tag_value FROM sc_campus_profile_tag
        WHERE delete_flag = 'NOT_DELETE' AND revision_id IN (${sql.join(revisionIds.map((id) => sql`${id}`))})
        ORDER BY sort_code ASC, id ASC`,
  );
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const id = cellText(row, 'revision_id') ?? '';
    grouped.set(id, [...(grouped.get(id) ?? []), row]);
  }
  return grouped;
}

function valuesByType(tags: Row[], type: string) {
  return tags.filter((item) => cellText(item, 'tag_type') === type).map((item) => cellText(item, 'tag_value') ?? '');
}

function publicProfile(profile: Row, revision: Row, tags: Row[]) {
  const count = cellNumber(profile, 'rating_count');
  const total = cellNumber(profile, 'rating_total');
  return {
    id: cellText(profile, 'id'),
    roleType: cellText(profile, 'role_type'),
    avatarType: cellText(revision, 'avatar_type'),
    avatarValue: cellText(revision, 'avatar_value'),
    name: cellText(revision, 'name'),
    orgName: cellText(revision, 'org_name'),
    region: cellText(revision, 'region'),
    grade: cellText(revision, 'grade'),
    category: cellText(revision, 'category'),
    scaleText: cellText(revision, 'scale_text'),
    activityCount: revision.activity_count == null ? null : cellNumber(revision, 'activity_count'),
    intro: cellText(revision, 'intro'),
    pinned: flag(profile.pinned_flag),
    vip: isVipActive(profile),
    ratingCount: count,
    ratingAverage: ratingAverage(total, count),
    approvedTime: asDate(profile.approved_time),
    teamTags: valuesByType(tags, TAG_TEAM),
    workTags: valuesByType(tags, TAG_WORK),
    businessTags: valuesByType(tags, TAG_BUSINESS),
    operationTags: valuesByType(tags, TAG_OPERATION),
  };
}

async function revisionsById(db: CampusDb, ids: string[]) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map<string, Row>();
  const rows = await queryRows(
    db,
    sql`SELECT * FROM sc_campus_profile_revision
        WHERE delete_flag = 'NOT_DELETE' AND id IN (${sql.join(unique.map((id) => sql`${id}`))})`,
  );
  return new Map(rows.map((row) => [cellText(row, 'id') ?? '', row]));
}

async function assembleProfiles(db: CampusDb, profiles: Row[], revisionKey: 'approved_revision_id' | 'latest_revision_id') {
  const revisions = await revisionsById(
    db,
    profiles.map((profile) => cellText(profile, revisionKey) ?? ''),
  );
  const tags = await tagsByRevision(db, [...revisions.keys()]);
  return profiles.flatMap((profile) => {
    const revisionId = cellText(profile, revisionKey);
    const revision = revisionId ? revisions.get(revisionId) : undefined;
    if (!revision) return [];
    const base = publicProfile(profile, revision, tags.get(revision.id as string) ?? tags.get(revisionId ?? '') ?? []);
    return [{ profile, revision, base }];
  });
}

export async function publicProfilePage(db: CampusDb, query: Record<string, unknown>) {
  const roleType = text(query.roleType);
  const keyword = text(query.keyword);
  const seed = text(query.shuffleSeed).replace(/[^A-Za-z0-9_-]/g, '');
  limitLength(keyword, 64, '关键词不能超过64字');
  limitLength(text(query.shuffleSeed), 64, '排序种子不能超过64字');
  if (roleType && !ROLE_TYPES.has(roleType)) throw campus(121010, '身份类型不合法');
  const page = pageQuery(query, 9, 100);
  const filters = [
    alive('sc_campus_profile'),
    sql`status = ${APPROVED}`,
    sql`hidden_flag = 0`,
    sql`approved_revision_id IS NOT NULL`,
  ];
  if (roleType) filters.push(sql`role_type = ${roleType}`);
  if (keyword) {
    const like = `%${keyword}%`;
    filters.push(sql`(
      EXISTS (SELECT 1 FROM sc_campus_profile_revision r
        WHERE r.id = sc_campus_profile.approved_revision_id AND r.delete_flag = 'NOT_DELETE'
          AND (r.name LIKE ${like} OR r.org_name LIKE ${like} OR r.region LIKE ${like}
            OR r.category LIKE ${like} OR r.intro LIKE ${like}))
      OR EXISTS (SELECT 1 FROM sc_campus_profile_tag t
        WHERE t.revision_id = sc_campus_profile.approved_revision_id
          AND t.delete_flag = 'NOT_DELETE' AND t.tag_value LIKE ${like})
    )`);
  }
  const where = sql.join(filters, sql` AND `);
  const order = seed
    ? sql`pinned_flag DESC, CASE WHEN vip_flag = 1 AND (vip_expire_time IS NULL OR vip_expire_time > NOW()) THEN 1 ELSE 0 END DESC, MD5(CONCAT(id, ${seed})) ASC`
    : sql`pinned_flag DESC, CASE WHEN vip_flag = 1 AND (vip_expire_time IS NULL OR vip_expire_time > NOW()) THEN 1 ELSE 0 END DESC, approved_time DESC`;
  const total = await queryCount(db, sql`SELECT COUNT(*) AS total FROM sc_campus_profile WHERE ${where}`);
  const records = await queryRows(
    db,
    sql`SELECT * FROM sc_campus_profile WHERE ${where} ORDER BY ${order} LIMIT ${page.size} OFFSET ${page.offset}`,
  );
  const assembled = await assembleProfiles(db, records, 'approved_revision_id');
  return pageResult(assembled.map((item) => item.base), total, page.current, page.size);
}

export async function publicProfileDetail(db: CampusDb, id: string) {
  const profile = await queryOne(
    db,
    sql`SELECT * FROM sc_campus_profile
        WHERE delete_flag = 'NOT_DELETE' AND id = ${id} AND status = ${APPROVED} AND hidden_flag = 0 LIMIT 1`,
  );
  if (!profile) throw campus(121001, '名片不存在');
  const assembled = await assembleProfiles(db, [profile], 'approved_revision_id');
  const result = assembled[0]?.base;
  if (!result) throw campus(121001, '名片不存在');
  return result;
}

async function profileByUser(db: CampusDb, userId: string) {
  return queryOne(db, sql`SELECT * FROM sc_campus_profile WHERE delete_flag = 'NOT_DELETE' AND user_id = ${userId} LIMIT 1`);
}

async function requireProfile(db: CampusDb, id: string) {
  const profile = await queryOne(db, sql`SELECT * FROM sc_campus_profile WHERE delete_flag = 'NOT_DELETE' AND id = ${id} LIMIT 1`);
  if (!profile) throw campus(121001, '名片不存在');
  return profile;
}

function mineProfile(profile: Row, revision: Row, base: ReturnType<typeof publicProfile>) {
  return {
    ...base,
    status: cellText(profile, 'status'),
    rejectReason: cellText(revision, 'reject_reason'),
    wechat: sm4Decrypt(revision.wechat),
    phone: sm4Decrypt(revision.phone),
    revisionNo: cellNumber(revision, 'revision_no'),
    version: cellNumber(profile, 'version'),
    hidden: flag(profile.hidden_flag),
    vipExpireTime: asDate(profile.vip_expire_time),
  };
}

export async function myProfile(db: CampusDb, userId: string) {
  const profile = await profileByUser(db, userId);
  if (!profile || !cellText(profile, 'latest_revision_id')) return null;
  const assembled = await assembleProfiles(db, [profile], 'latest_revision_id');
  const item = assembled[0];
  return item ? mineProfile(item.profile, item.revision, item.base) : null;
}

async function saveTags(db: CampusDb, revisionId: string, type: string, values: string[] | null, userId: string) {
  if (!values) return;
  let sort = 1;
  for (const value of [...new Set(values)]) {
    if (!value.trim()) continue;
    await insertRow(db, 'sc_campus_profile_tag', {
      ...stamp(userId),
      revision_id: revisionId,
      tag_type: type,
      tag_value: value.trim(),
      sort_code: sort,
    });
    sort += 1;
  }
}

async function claimOwnedFile(db: CampusDb, userId: string, scene: string, fileRef: string) {
  if (!userId || !scene || !fileRef) throw campus(121011, '文件标识不能为空');
  const normalized = scene.trim().toUpperCase();
  if (!FILE_SCENES.has(normalized)) throw campus(121011, '文件上传场景不合法');
  const hash = sha256(fileRef);
  const upload = await queryOne(
    db,
    sql`SELECT id, used_flag FROM sc_campus_upload_file
        WHERE delete_flag = 'NOT_DELETE' AND user_id = ${userId} AND scene = ${normalized}
          AND file_ref_hash = ${hash} AND file_ref = ${fileRef}
        ORDER BY create_time DESC LIMIT 1`,
  );
  if (!upload) throw campus(121011, '文件不存在或不属于当前用户');
  if (!flag(upload.used_flag)) {
    await sql`UPDATE sc_campus_upload_file SET used_flag = 1, used_time = ${new Date()}
              WHERE id = ${cellText(upload, 'id')} AND used_flag = 0`.execute(db);
  }
}

export async function submitProfile(db: CampusDb, env: AppEnv, userId: string, body: Record<string, unknown>) {
  const roleType = text(body.roleType);
  const avatarType = text(body.avatarType);
  const avatarValue = text(body.avatarValue);
  const name = text(body.name);
  const orgName = text(body.orgName);
  const region = text(body.region);
  const grade = text(body.grade);
  const category = text(body.category);
  const scaleText = text(body.scaleText);
  const intro = text(body.intro);
  const wechat = text(body.wechat);
  const phone = text(body.phone);
  const teamTags = stringList(body.teamTags);
  const workTags = stringList(body.workTags);
  const businessTags = stringList(body.businessTags);
  requireBound(roleType, '身份类型不能为空', 32, '身份类型不能超过32字');
  requireBound(avatarType, '头像类型不能为空', 32, '头像类型不能超过32字');
  limitLength(avatarValue, 512, '头像值不能超过512字');
  requireBound(name, '名称不能为空', 64, '名称不能超过64字');
  requireBound(orgName, '组织名称不能为空', 128, '组织名称不能超过128字');
  limitLength(region, 64, '地区不能超过64字');
  limitLength(grade, 32, '年级不能超过32字');
  limitLength(category, 64, '分类不能超过64字');
  limitLength(scaleText, 64, '规模信息不能超过64字');
  limitLength(intro, 2000, '介绍不能超过2000字');
  requireBound(wechat, '微信号不能为空', 64, '微信号不能超过64字');
  limitLength(phone, 32, '手机号不能超过32字');
  limitList(teamTags, 20, '团队标签不能超过20个', '标签不能超过64字');
  limitList(workTags, 20, '工作内容不能超过20项', '标签不能超过64字');
  limitList(businessTags, 20, '业务标签不能超过20个', '标签不能超过64字');
  const activityCount = body.activityCount == null || body.activityCount === '' ? null : intValue(body.activityCount);
  if (activityCount != null && (activityCount < 0 || activityCount > 10000)) {
    throw campus(500, activityCount < 0 ? '活动场次不能小于0' : '活动场次不合法');
  }
  if (!ROLE_TYPES.has(roleType)) throw campus(121010, '身份类型不合法');
  if (!AVATAR_TYPES.has(avatarType) || !avatarValue) throw campus(121010, '头像类型或头像值不合法');
  if (roleType === AMBASSADOR && !grade) throw campus(121010, '校园大使年级不能为空');
  if (roleType !== AMBASSADOR && !category) throw campus(121010, '社团类型或品牌行业不能为空');

  return withLock(env, `campus-circle:profile:submit:${userId}`, 3000, 15, '名片正在提交，请稍后重试', async () =>
    db.transaction().execute(async (trx) => {
      if (avatarType === AVATAR_IMAGE) await claimOwnedFile(trx, userId, FILE_AVATAR, avatarValue);
      let profile = await profileByUser(trx, userId);
      if (!profile) {
        const created = {
          ...stamp(userId),
          user_id: userId,
          role_type: roleType,
          latest_revision_id: null,
          approved_revision_id: null,
          status: PENDING,
          hidden_flag: 0,
          pinned_flag: 0,
          vip_flag: 0,
          vip_expire_time: null,
          rating_total: 0,
          rating_count: 0,
          approved_time: null,
          version: 0,
        };
        await insertRow(trx, 'sc_campus_profile', created);
        profile = created;
      } else if (cellText(profile, 'role_type') !== roleType) {
        const latest = await latestVerification(trx, userId);
        if (latest && cellText(latest, 'status') === APPROVED) {
          throw campus(121006, '已认证用户不能直接变更身份，请联系运营处理');
        }
      }
      const profileId = cellText(profile, 'id') ?? '';
      const latestNo = await queryOne(
        trx,
        sql`SELECT revision_no FROM sc_campus_profile_revision
            WHERE delete_flag = 'NOT_DELETE' AND profile_id = ${profileId}
            ORDER BY revision_no DESC LIMIT 1`,
      );
      const revisionId = newId();
      const revision = {
        ...stamp(userId),
        id: revisionId,
        profile_id: profileId,
        revision_no: cellNumber(latestNo, 'revision_no') + (latestNo ? 1 : 1),
        avatar_type: avatarType,
        avatar_value: avatarValue,
        name,
        org_name: orgName,
        region: region || null,
        grade: grade || null,
        category: category || null,
        scale_text: scaleText || null,
        activity_count: activityCount,
        intro: intro || null,
        wechat: sm4Encrypt(wechat),
        phone: sm4Encrypt(phone),
        status: PENDING,
        reject_reason: null,
        review_time: null,
        review_user_id: null,
      };
      if (!latestNo) revision.revision_no = 1;
      await insertRow(trx, 'sc_campus_profile_revision', revision);
      await saveTags(trx, revisionId, TAG_TEAM, teamTags, userId);
      await saveTags(trx, revisionId, TAG_WORK, workTags, userId);
      await saveTags(trx, revisionId, TAG_BUSINESS, businessTags, userId);
      const approvedRevisionId = cellText(profile, 'approved_revision_id');
      if (approvedRevisionId) {
        const operationTags = await queryRows(
          trx,
          sql`SELECT tag_value FROM sc_campus_profile_tag
              WHERE delete_flag = 'NOT_DELETE' AND revision_id = ${approvedRevisionId} AND tag_type = ${TAG_OPERATION}
              ORDER BY sort_code ASC`,
        );
        await saveTags(trx, revisionId, TAG_OPERATION, operationTags.map((row) => cellText(row, 'tag_value') ?? ''), userId);
      }
      const version = cellNumber(profile, 'version');
      const updated = await executeAffected(
        trx,
        sql`UPDATE sc_campus_profile
            SET role_type = ${roleType}, latest_revision_id = ${revisionId}, status = ${PENDING},
                version = ${version + 1}, update_time = ${new Date()}, update_user = ${userId}
            WHERE id = ${profileId} AND version = ${version} AND delete_flag = 'NOT_DELETE'`,
      );
      if (updated !== 1) throw campus(121009, '名片已被更新，请刷新后重试');
      return profileId;
    }),
  );
}

export async function adminProfilePage(db: CampusDb, query: Record<string, unknown>) {
  const status = text(query.status);
  const roleType = text(query.type);
  const keyword = text(query.keyword);
  limitLength(status, 32, '审核状态不能超过32字');
  limitLength(roleType, 32, '类型不能超过32字');
  limitLength(keyword, 64, '关键词不能超过64字');
  if (roleType && !ROLE_TYPES.has(roleType)) throw campus(121010, '身份类型不合法');
  const page = pageQuery(query, 20, 100);
  const filters = [alive('sc_campus_profile')];
  if (status) filters.push(sql`status = ${status}`);
  if (roleType) filters.push(sql`role_type = ${roleType}`);
  if (keyword) {
    const like = `%${keyword}%`;
    filters.push(sql`(
      EXISTS (SELECT 1 FROM sc_campus_profile_revision r
        WHERE r.id = sc_campus_profile.latest_revision_id AND r.delete_flag = 'NOT_DELETE'
          AND (r.name LIKE ${like} OR r.org_name LIKE ${like} OR r.region LIKE ${like}
            OR r.category LIKE ${like} OR r.intro LIKE ${like}))
      OR EXISTS (SELECT 1 FROM sc_campus_profile_tag t
        WHERE t.revision_id = sc_campus_profile.latest_revision_id
          AND t.delete_flag = 'NOT_DELETE' AND t.tag_value LIKE ${like})
    )`);
  }
  const where = sql.join(filters, sql` AND `);
  const total = await queryCount(db, sql`SELECT COUNT(*) AS total FROM sc_campus_profile WHERE ${where}`);
  const records = await queryRows(
    db,
    sql`SELECT * FROM sc_campus_profile WHERE ${where} ORDER BY create_time DESC LIMIT ${page.size} OFFSET ${page.offset}`,
  );
  const assembled = await assembleProfiles(db, records, 'latest_revision_id');
  return pageResult(
    assembled.map((item) => ({
      ...item.base,
      status: cellText(item.profile, 'status'),
      rejectReason: cellText(item.revision, 'reject_reason'),
      revisionNo: cellNumber(item.revision, 'revision_no'),
      version: cellNumber(item.profile, 'version'),
      hidden: flag(item.profile.hidden_flag),
      vipExpireTime: asDate(item.profile.vip_expire_time),
      createTime: asDate(item.profile.create_time),
    })),
    total,
    page.current,
    page.size,
  );
}

export async function adminProfileDetail(db: CampusDb, id: string) {
  const profile = await requireProfile(db, id);
  const assembled = await assembleProfiles(db, [profile], 'latest_revision_id');
  const item = assembled[0];
  return item ? mineProfile(item.profile, item.revision, item.base) : null;
}

export async function reviewProfile(db: CampusDb, operatorId: string, body: Record<string, unknown>) {
  const id = text(body.id);
  const action = text(body.action);
  const reason = optionalText(body.reason);
  const version = intValue(body.version);
  requireBound(id, '业务id不能为空', 64, '业务id不能超过64字');
  requireBound(action, '审核动作不能为空', 32, '审核动作不能超过32字');
  if (version == null) throw campus(500, '版本号不能为空');
  if (version < 0) throw campus(500, '版本号不合法');
  if (!new Set(['PASS', 'REJECT']).has(action)) throw campus(121010, '不支持的审核动作');
  if (action === REJECT && !reason) throw campus(121010, '拒绝原因不能为空');
  const profile = await requireProfile(db, id);
  if (cellText(profile, 'status') !== PENDING) throw campus(121010, '只有待审核名片可以审核');
  if (cellNumber(profile, 'version') !== version) throw campus(121009, '数据已被更新，请刷新后重试');
  const revision = await queryOne(
    db,
    sql`SELECT * FROM sc_campus_profile_revision WHERE delete_flag = 'NOT_DELETE' AND id = ${cellText(profile, 'latest_revision_id')} LIMIT 1`,
  );
  if (!revision) throw campus(121001, '名片版本不存在');
  const afterStatus = action === PASS ? APPROVED : REJECTED;
  const now = new Date();
  await db.transaction().execute(async (trx) => {
    const updated = await executeAffected(
      trx,
      sql`UPDATE sc_campus_profile
          SET status = ${afterStatus},
              approved_revision_id = ${afterStatus === APPROVED ? cellText(revision, 'id') : cellText(profile, 'approved_revision_id')},
              approved_time = ${afterStatus === APPROVED ? now : asDate(profile.approved_time)},
              version = ${version + 1}, update_time = ${now}, update_user = ${operatorId}
          WHERE id = ${id} AND version = ${version} AND delete_flag = 'NOT_DELETE'`,
    );
    if (updated !== 1) throw campus(121009, '名片已被其他运营人员更新');
    await sql`UPDATE sc_campus_profile_revision
              SET status = ${afterStatus}, reject_reason = ${afterStatus === REJECTED ? reason : null},
                  review_time = ${now}, review_user_id = ${operatorId}, update_time = ${now}, update_user = ${operatorId}
              WHERE id = ${cellText(revision, 'id')}`.execute(trx);
    await recordReview(trx, {
      businessType: PROFILE,
      businessId: id,
      version,
      action,
      beforeStatus: PENDING,
      afterStatus,
      reason,
      operatorId,
    });
  });
}

async function latestVerification(db: CampusDb, userId: string) {
  return queryOne(
    db,
    sql`SELECT * FROM sc_campus_verification
        WHERE delete_flag = 'NOT_DELETE' AND user_id = ${userId}
        ORDER BY version_no DESC LIMIT 1`,
  );
}

export async function operateProfile(db: CampusDb, operatorId: string, body: Record<string, unknown>) {
  const id = text(body.id);
  const action = text(body.action);
  const reason = optionalText(body.reason);
  const version = intValue(body.version);
  const tags = stringList(body.tags);
  requireBound(id, '业务id不能为空', 64, '业务id不能超过64字');
  requireBound(action, '操作动作不能为空', 32, '操作动作不能超过32字');
  if (version == null) throw campus(500, '版本号不能为空');
  if (version < 0) throw campus(500, '版本号不合法');
  limitLength(reason ?? '', 500, '原因不能超过500字');
  limitList(tags, 20, '运营标签不能超过20个', '运营标签不能超过64字');
  if (!PROFILE_OPERATIONS.has(action)) throw campus(121010, '不支持的运营动作');
  if ((action === HIDE || action === SHOW || action === CANCEL_VIP) && !reason) {
    throw campus(121010, '该操作必须填写原因');
  }
  const profile = await requireProfile(db, id);
  if (cellNumber(profile, 'version') !== version) throw campus(121009, '数据已被更新，请刷新后重试');
  if ((action === SHOW || action === PIN) && cellText(profile, 'status') !== APPROVED) {
    throw campus(121010, '未审核通过的名片不能展示或置顶');
  }
  if (action === GRANT_VIP) {
    const latest = await latestVerification(db, cellText(profile, 'user_id') ?? '');
    if (!latest || cellText(latest, 'status') !== APPROVED) throw campus(121002, '只有已认证用户可以开通VIP');
    const expire = asDate(body.vipExpireTime);
    if (expire && expire.getTime() <= Date.now()) throw campus(121010, 'VIP有效期必须晚于当前时间');
  }
  if (action === SET_TAGS && cellText(profile, 'status') !== APPROVED) {
    throw campus(121010, '只有已审核通过名片可以设置运营标签');
  }
  if (action === SET_TAGS && !cellText(profile, 'approved_revision_id')) {
    throw campus(121010, '名片缺少已发布版本，不能设置运营标签');
  }
  const sets = [sql`version = ${version + 1}`, sql`update_time = ${new Date()}`, sql`update_user = ${operatorId}`];
  if (action === HIDE) sets.push(sql`hidden_flag = 1`);
  if (action === SHOW) sets.push(sql`hidden_flag = 0`);
  if (action === PIN) sets.push(sql`pinned_flag = 1`);
  if (action === UNPIN) sets.push(sql`pinned_flag = 0`);
  if (action === GRANT_VIP) sets.push(sql`vip_flag = 1`, sql`vip_expire_time = ${asDate(body.vipExpireTime)}`);
  if (action === CANCEL_VIP) sets.push(sql`vip_flag = 0`, sql`vip_expire_time = NULL`);
  await db.transaction().execute(async (trx) => {
    const updated = await executeAffected(
      trx,
      sql`UPDATE sc_campus_profile SET ${sql.join(sets)}
          WHERE id = ${id} AND version = ${version} AND delete_flag = 'NOT_DELETE'`,
    );
    if (updated !== 1) throw campus(121009, '名片已被其他运营人员更新');
    if (action === SET_TAGS) {
      const revisionId = cellText(profile, 'approved_revision_id');
      await sql`DELETE FROM sc_campus_profile_tag WHERE revision_id = ${revisionId} AND tag_type = ${TAG_OPERATION}`.execute(trx);
      await saveTags(trx, revisionId ?? '', TAG_OPERATION, tags, operatorId);
    }
    await recordReview(trx, {
      businessType: PROFILE,
      businessId: id,
      version,
      action,
      beforeStatus: cellText(profile, 'status') ?? '',
      afterStatus: cellText(profile, 'status') ?? '',
      reason,
      operatorId,
    });
  });
}

async function projectTagsAndImages(db: CampusDb, projectIds: string[]) {
  if (projectIds.length === 0) return { tags: new Map<string, string[]>(), images: new Map<string, string[]>() };
  const ids = sql.join(projectIds.map((id) => sql`${id}`));
  const tags = await queryRows(
    db,
    sql`SELECT project_id, tag_value FROM sc_campus_project_tag
        WHERE delete_flag = 'NOT_DELETE' AND project_id IN (${ids}) ORDER BY sort_code ASC, id ASC`,
  );
  const images = await queryRows(
    db,
    sql`SELECT project_id, file_id FROM sc_campus_project_image
        WHERE delete_flag = 'NOT_DELETE' AND project_id IN (${ids}) ORDER BY sort_code ASC, id ASC`,
  );
  const tagMap = new Map<string, string[]>();
  const imageMap = new Map<string, string[]>();
  for (const row of tags) {
    const id = cellText(row, 'project_id') ?? '';
    tagMap.set(id, [...(tagMap.get(id) ?? []), cellText(row, 'tag_value') ?? '']);
  }
  for (const row of images) {
    const id = cellText(row, 'project_id') ?? '';
    imageMap.set(id, [...(imageMap.get(id) ?? []), cellText(row, 'file_id') ?? '']);
  }
  return { tags: tagMap, images: imageMap };
}

async function assembleProjects(db: CampusDb, projects: Row[]) {
  const profiles = new Map<string, Row>();
  const profileIds = [...new Set(projects.map((item) => cellText(item, 'profile_id') ?? '').filter(Boolean))];
  if (profileIds.length > 0) {
    const rows = await queryRows(
      db,
      sql`SELECT * FROM sc_campus_profile WHERE delete_flag = 'NOT_DELETE' AND id IN (${sql.join(profileIds.map((id) => sql`${id}`))})`,
    );
    for (const row of rows) profiles.set(cellText(row, 'id') ?? '', row);
  }
  const revisionIds = [...profiles.values()].map(
    (profile) => cellText(profile, 'approved_revision_id') || cellText(profile, 'latest_revision_id') || '',
  );
  const revisions = await revisionsById(db, revisionIds);
  const extras = await projectTagsAndImages(db, projects.map((item) => cellText(item, 'id') ?? ''));
  return projects.map((project) => {
    const profile = profiles.get(cellText(project, 'profile_id') ?? '');
    const revisionId = profile ? cellText(profile, 'approved_revision_id') || cellText(profile, 'latest_revision_id') : '';
    const revision = revisionId ? revisions.get(revisionId) : undefined;
    const id = cellText(project, 'id') ?? '';
    return {
      id,
      profileId: cellText(project, 'profile_id'),
      projectType: cellText(project, 'project_type'),
      title: cellText(project, 'title'),
      description: cellText(project, 'description'),
      eventType: cellText(project, 'event_type'),
      estimatedScale: cellText(project, 'estimated_scale'),
      eventTimeText: cellText(project, 'event_time_text'),
      location: cellText(project, 'location'),
      budgetRange: cellText(project, 'budget_range'),
      payModel: cellText(project, 'pay_model'),
      coverageRegion: cellText(project, 'coverage_region'),
      recruitCountText: cellText(project, 'recruit_count_text'),
      budgetText: cellText(project, 'budget_text'),
      pinned: flag(project.pinned_flag),
      approvedTime: asDate(project.approved_time),
      publisherVip: isVipActive(profile),
      publisherName: revision ? cellText(revision, 'name') : null,
      publisherOrgName: revision ? cellText(revision, 'org_name') : null,
      tags: extras.tags.get(id) ?? [],
      imageFileIds: extras.images.get(id) ?? [],
      project,
    };
  });
}

function publicProjectExists() {
  return sql`EXISTS (
    SELECT 1 FROM sc_campus_profile cp
    WHERE cp.id = sc_campus_project.profile_id AND cp.status = 'APPROVED'
      AND cp.hidden_flag = 0 AND cp.delete_flag = 'NOT_DELETE'
  )`;
}

export async function publicProjectPage(db: CampusDb, query: Record<string, unknown>) {
  const projectType = text(query.projectType);
  const keyword = text(query.keyword);
  limitLength(keyword, 64, '关键词不能超过64字');
  if (projectType && !PROJECT_TYPES.has(projectType)) throw campus(121010, '项目类型不合法');
  const page = pageQuery(query, 9, 100);
  const filters = [alive('sc_campus_project'), sql`status = ${APPROVED}`, sql`hidden_flag = 0`, publicProjectExists()];
  if (projectType) filters.push(sql`project_type = ${projectType}`);
  if (keyword) {
    const like = `%${keyword}%`;
    filters.push(sql`(
      title LIKE ${like} OR description LIKE ${like} OR location LIKE ${like}
      OR budget_range LIKE ${like} OR budget_text LIKE ${like}
      OR EXISTS (SELECT 1 FROM sc_campus_project_tag t
        WHERE t.project_id = sc_campus_project.id AND t.delete_flag = 'NOT_DELETE' AND t.tag_value LIKE ${like})
    )`);
  }
  const where = sql.join(filters, sql` AND `);
  const order = sql`pinned_flag DESC, CASE WHEN EXISTS (
    SELECT 1 FROM sc_campus_profile vp WHERE vp.id = sc_campus_project.profile_id AND vp.vip_flag = 1
      AND (vp.vip_expire_time IS NULL OR vp.vip_expire_time > NOW())) THEN 1 ELSE 0 END DESC, approved_time DESC`;
  const total = await queryCount(db, sql`SELECT COUNT(*) AS total FROM sc_campus_project WHERE ${where}`);
  const records = await queryRows(
    db,
    sql`SELECT * FROM sc_campus_project WHERE ${where} ORDER BY ${order} LIMIT ${page.size} OFFSET ${page.offset}`,
  );
  const assembled = await assembleProjects(db, records);
  return pageResult(
    assembled.map(({ project: _project, ...item }) => item),
    total,
    page.current,
    page.size,
  );
}

async function profileAvailable(db: CampusDb, profileId: string) {
  const count = await queryCount(
    db,
    sql`SELECT COUNT(*) AS total FROM sc_campus_profile
        WHERE delete_flag = 'NOT_DELETE' AND id = ${profileId} AND status = ${APPROVED} AND hidden_flag = 0`,
  );
  return count > 0;
}

export async function publicProjectDetail(db: CampusDb, id: string) {
  const project = await queryOne(
    db,
    sql`SELECT * FROM sc_campus_project
        WHERE delete_flag = 'NOT_DELETE' AND id = ${id} AND status = ${APPROVED} AND hidden_flag = 0 LIMIT 1`,
  );
  if (!project || !(await profileAvailable(db, cellText(project, 'profile_id') ?? ''))) throw campus(121001, '项目不存在');
  const assembled = await assembleProjects(db, [project]);
  const item = assembled[0];
  if (!item) throw campus(121001, '项目不存在');
  const { project: _project, ...result } = item;
  return result;
}

async function requireApprovedProfile(db: CampusDb, userId: string) {
  const profile = await profileByUser(db, userId);
  if (!profile || cellText(profile, 'status') !== APPROVED || flag(profile.hidden_flag)) {
    throw campus(121005, '请先完成主体名片审核');
  }
  return profile;
}

function mineProject(item: Awaited<ReturnType<typeof assembleProjects>>[number]) {
  const { project, ...base } = item;
  return {
    ...base,
    status: cellText(project, 'status'),
    rejectReason: cellText(project, 'reject_reason'),
    wechat: sm4Decrypt(project.wechat),
    phone: sm4Decrypt(project.phone),
    hidden: flag(project.hidden_flag),
    version: cellNumber(project, 'version'),
    createTime: asDate(project.create_time),
  };
}

export async function submitProject(db: CampusDb, userId: string, body: Record<string, unknown>) {
  const id = text(body.id);
  const version = intValue(body.version);
  const projectType = text(body.projectType);
  const title = text(body.title);
  const description = optionalText(body.description);
  const eventType = optionalText(body.eventType);
  const estimatedScale = optionalText(body.estimatedScale);
  const eventTimeText = optionalText(body.eventTimeText);
  const location = optionalText(body.location);
  const budgetRange = optionalText(body.budgetRange);
  const payModel = optionalText(body.payModel);
  const coverageRegion = optionalText(body.coverageRegion);
  const recruitCountText = optionalText(body.recruitCountText);
  const budgetText = optionalText(body.budgetText);
  const wechat = text(body.wechat);
  const phone = optionalText(body.phone);
  const tags = stringList(body.tags);
  const imageFileIds = stringList(body.imageFileIds);
  limitLength(id, 64, '项目id不能超过64字');
  if (body.version != null && body.version !== '' && (version == null || version < 0)) throw campus(500, '版本号不合法');
  requireBound(projectType, '项目类型不能为空', 32, '项目类型不能超过32字');
  requireBound(title, '项目标题不能为空', 128, '项目标题不能超过128字');
  limitLength(description ?? '', 3000, '项目详情不能超过3000字');
  limitLength(eventType ?? '', 64, '活动类型不能超过64字');
  limitLength(estimatedScale ?? '', 64, '预计规模不能超过64字');
  limitLength(eventTimeText ?? '', 128, '活动时间不能超过128字');
  limitLength(location ?? '', 128, '活动地点不能超过128字');
  limitLength(budgetRange ?? '', 64, '预算范围不能超过64字');
  limitLength(payModel ?? '', 64, '结算方式不能超过64字');
  limitLength(coverageRegion ?? '', 128, '覆盖地区不能超过128字');
  limitLength(recruitCountText ?? '', 64, '招募人数不能超过64字');
  limitLength(budgetText ?? '', 64, '合作预算不能超过64字');
  requireBound(wechat, '联系微信不能为空', 64, '联系微信不能超过64字');
  limitLength(phone ?? '', 32, '手机号不能超过32字');
  limitList(tags, 20, '项目标签不能超过20个', '标签不能超过64字');
  if (imageFileIds.length > 4) throw campus(500, '项目图片不能超过4张');
  if (imageFileIds.some((item) => item.length > 512)) throw campus(500, '文件标识不能超过512字');
  if (!PROJECT_TYPES.has(projectType)) throw campus(121010, '项目类型不合法');
  if (!tags.some((item) => item.trim())) throw campus(121010, '项目至少选择一项需求或工作内容');
  if (projectType === SPONSOR) {
    if (!eventType) throw campus(121010, '活动类型不能为空');
    if (!estimatedScale) throw campus(121010, '预计规模不能为空');
    if (!eventTimeText) throw campus(121010, '活动时间不能为空');
    if (!location) throw campus(121010, '活动地点不能为空');
    if (!budgetRange) throw campus(121010, '预算范围不能为空');
  } else {
    if (!payModel) throw campus(121010, '结算方式不能为空');
    if (!coverageRegion) throw campus(121010, '覆盖地区不能为空');
    if (!recruitCountText) throw campus(121010, '招募人数不能为空');
    if (!budgetText) throw campus(121010, '合作预算不能为空');
  }
  const profile = await requireApprovedProfile(db, userId);
  const matched = projectType === SPONSOR ? cellText(profile, 'role_type') === CLUB : cellText(profile, 'role_type') === BRAND;
  if (!matched) throw campus(121006, '校园社团只能发布找赞助，品牌方只能发布找大使');
  for (const fileRef of [...new Set(imageFileIds.map((item) => item.trim()).filter(Boolean))]) {
    await claimOwnedFile(db, userId, FILE_PROJECT, fileRef);
  }
  return db.transaction().execute(async (trx) => {
    let projectId = id;
    if (!id) {
      projectId = newId();
      const created = {
        ...stamp(userId),
        id: projectId,
        publisher_user_id: userId,
        profile_id: cellText(profile, 'id'),
        hidden_flag: 0,
        pinned_flag: 0,
        version: 0,
        ...projectColumns(projectType, title, description, eventType, estimatedScale, eventTimeText, location, budgetRange, payModel, coverageRegion, recruitCountText, budgetText, wechat, phone),
      };
      await insertRow(trx, 'sc_campus_project', created);
    } else {
      const current = await queryOne(trx, sql`SELECT * FROM sc_campus_project WHERE delete_flag = 'NOT_DELETE' AND id = ${id} LIMIT 1`);
      if (!current || cellText(current, 'publisher_user_id') !== userId) throw campus(121001, '项目不存在');
      if (version == null || version !== cellNumber(current, 'version')) throw campus(121009, '项目已被更新，请刷新后重试');
      const columns = projectColumns(projectType, title, description, eventType, estimatedScale, eventTimeText, location, budgetRange, payModel, coverageRegion, recruitCountText, budgetText, wechat, phone);
      const updated = await executeAffected(
        trx,
        sql`UPDATE sc_campus_project SET
            project_type = ${columns.project_type}, title = ${columns.title}, description = ${columns.description},
            event_type = ${columns.event_type}, estimated_scale = ${columns.estimated_scale}, event_time_text = ${columns.event_time_text},
            location = ${columns.location}, budget_range = ${columns.budget_range}, pay_model = ${columns.pay_model},
            coverage_region = ${columns.coverage_region}, recruit_count_text = ${columns.recruit_count_text}, budget_text = ${columns.budget_text},
            wechat = ${columns.wechat}, phone = ${columns.phone}, status = ${PENDING}, reject_reason = NULL,
            version = ${version + 1}, update_time = ${new Date()}, update_user = ${userId}
            WHERE id = ${id} AND publisher_user_id = ${userId} AND version = ${version} AND delete_flag = 'NOT_DELETE'`,
      );
      if (updated !== 1) throw campus(121009, '项目已被更新，请刷新后重试');
      await sql`DELETE FROM sc_campus_project_tag WHERE project_id = ${id}`.execute(trx);
      await sql`DELETE FROM sc_campus_project_image WHERE project_id = ${id}`.execute(trx);
    }
    await saveProjectChildren(trx, projectId, projectType, tags, imageFileIds, userId);
    return projectId;
  });
}

function projectColumns(
  projectType: string,
  title: string,
  description: string | null,
  eventType: string | null,
  estimatedScale: string | null,
  eventTimeText: string | null,
  location: string | null,
  budgetRange: string | null,
  payModel: string | null,
  coverageRegion: string | null,
  recruitCountText: string | null,
  budgetText: string | null,
  wechat: string,
  phone: string | null,
) {
  return {
    project_type: projectType,
    title,
    description,
    event_type: eventType,
    estimated_scale: estimatedScale,
    event_time_text: eventTimeText,
    location,
    budget_range: budgetRange,
    pay_model: payModel,
    coverage_region: coverageRegion,
    recruit_count_text: recruitCountText,
    budget_text: budgetText,
    wechat: sm4Encrypt(wechat),
    phone: sm4Encrypt(phone),
    status: PENDING,
    reject_reason: null,
  };
}

async function saveProjectChildren(db: CampusDb, projectId: string, projectType: string, tags: string[], imageFileIds: string[], userId: string) {
  const tagType = projectType === SPONSOR ? TAG_SPONSOR_NEED : TAG_WORK;
  let sort = 1;
  for (const value of [...new Set(tags)]) {
    if (!value.trim()) continue;
    await insertRow(db, 'sc_campus_project_tag', {
      ...stamp(userId),
      project_id: projectId,
      tag_type: tagType,
      tag_value: value.trim(),
      sort_code: sort,
    });
    sort += 1;
  }
  sort = 1;
  for (const fileId of [...new Set(imageFileIds)]) {
    if (!fileId.trim()) continue;
    await insertRow(db, 'sc_campus_project_image', {
      ...stamp(userId),
      project_id: projectId,
      file_id: fileId.trim(),
      sort_code: sort,
    });
    sort += 1;
  }
}

export async function myProjectPage(db: CampusDb, userId: string, query: Record<string, unknown>) {
  const status = text(query.status);
  const type = text(query.type);
  const keyword = text(query.keyword);
  limitLength(status, 32, '审核状态不能超过32字');
  limitLength(type, 32, '类型不能超过32字');
  limitLength(keyword, 64, '关键词不能超过64字');
  if (type && !PROJECT_TYPES.has(type)) throw campus(121010, '项目类型不合法');
  const page = pageQuery(query, 20, 100);
  const filters = [sql`delete_flag = 'NOT_DELETE'`, sql`publisher_user_id = ${userId}`];
  if (status) filters.push(sql`status = ${status}`);
  if (type) filters.push(sql`project_type = ${type}`);
  const where = sql.join(filters, sql` AND `);
  const total = await queryCount(db, sql`SELECT COUNT(*) AS total FROM sc_campus_project WHERE ${where}`);
  const records = await queryRows(
    db,
    sql`SELECT * FROM sc_campus_project WHERE ${where} ORDER BY create_time DESC LIMIT ${page.size} OFFSET ${page.offset}`,
  );
  return pageResult((await assembleProjects(db, records)).map(mineProject), total, page.current, page.size);
}

export async function adminProjectPage(db: CampusDb, query: Record<string, unknown>) {
  const status = text(query.status);
  const type = text(query.type);
  const keyword = text(query.keyword);
  limitLength(status, 32, '审核状态不能超过32字');
  limitLength(type, 32, '类型不能超过32字');
  limitLength(keyword, 64, '关键词不能超过64字');
  if (type && !PROJECT_TYPES.has(type)) throw campus(121010, '项目类型不合法');
  const page = pageQuery(query, 20, 100);
  const filters = [sql`delete_flag = 'NOT_DELETE'`];
  if (status) filters.push(sql`status = ${status}`);
  if (type) filters.push(sql`project_type = ${type}`);
  if (keyword) {
    const like = `%${keyword}%`;
    filters.push(sql`(title LIKE ${like} OR description LIKE ${like} OR location LIKE ${like})`);
  }
  const where = sql.join(filters, sql` AND `);
  const total = await queryCount(db, sql`SELECT COUNT(*) AS total FROM sc_campus_project WHERE ${where}`);
  const records = await queryRows(
    db,
    sql`SELECT * FROM sc_campus_project WHERE ${where} ORDER BY create_time DESC LIMIT ${page.size} OFFSET ${page.offset}`,
  );
  return pageResult(
    (await assembleProjects(db, records)).map((item) => {
      const { project, ...base } = item;
      return {
        ...base,
        status: cellText(project, 'status'),
        rejectReason: cellText(project, 'reject_reason'),
        hidden: flag(project.hidden_flag),
        version: cellNumber(project, 'version'),
        createTime: asDate(project.create_time),
      };
    }),
    total,
    page.current,
    page.size,
  );
}

async function requireProject(db: CampusDb, id: string) {
  const project = await queryOne(db, sql`SELECT * FROM sc_campus_project WHERE delete_flag = 'NOT_DELETE' AND id = ${id} LIMIT 1`);
  if (!project) throw campus(121001, '项目不存在');
  return project;
}

export async function adminProjectDetail(db: CampusDb, id: string) {
  const project = await requireProject(db, id);
  const assembled = await assembleProjects(db, [project]);
  const item = assembled[0];
  if (!item) throw campus(121001, '项目不存在');
  return mineProject(item);
}

export async function reviewProject(db: CampusDb, operatorId: string, body: Record<string, unknown>) {
  const id = text(body.id);
  const action = text(body.action);
  const reason = optionalText(body.reason);
  const version = intValue(body.version);
  requireBound(id, '业务id不能为空', 64, '业务id不能超过64字');
  requireBound(action, '审核动作不能为空', 32, '审核动作不能超过32字');
  if (version == null) throw campus(500, '版本号不能为空');
  if (version < 0) throw campus(500, '版本号不合法');
  if (action !== PASS && action !== REJECT) throw campus(121010, '不支持的审核动作');
  if (action === REJECT && !reason) throw campus(121010, '拒绝原因不能为空');
  const project = await requireProject(db, id);
  if (cellText(project, 'status') !== PENDING) throw campus(121010, '只有待审核项目可以审核');
  if (cellNumber(project, 'version') !== version) throw campus(121009, '项目已被更新，请刷新后重试');
  const publisher = await requireProfile(db, cellText(project, 'profile_id') ?? '');
  if (cellText(publisher, 'status') !== APPROVED || flag(publisher.hidden_flag)) {
    throw campus(121005, '发布主体名片当前不可用');
  }
  const projectType = cellText(project, 'project_type') ?? '';
  const matched = projectType === SPONSOR ? cellText(publisher, 'role_type') === CLUB : cellText(publisher, 'role_type') === BRAND;
  if (!matched) throw campus(121006, '校园社团只能发布找赞助，品牌方只能发布找大使');
  const afterStatus = action === PASS ? APPROVED : REJECTED;
  const now = new Date();
  await db.transaction().execute(async (trx) => {
    const updated = await executeAffected(
      trx,
      sql`UPDATE sc_campus_project
          SET status = ${afterStatus}, reject_reason = ${afterStatus === REJECTED ? reason : null},
              approved_time = ${afterStatus === APPROVED ? now : asDate(project.approved_time)},
              review_time = ${now}, review_user_id = ${operatorId}, version = ${version + 1},
              update_time = ${now}, update_user = ${operatorId}
          WHERE id = ${id} AND version = ${version} AND delete_flag = 'NOT_DELETE'`,
    );
    if (updated !== 1) throw campus(121009, '项目已被其他运营人员更新');
    await recordReview(trx, {
      businessType: PROJECT,
      businessId: id,
      version,
      action,
      beforeStatus: PENDING,
      afterStatus,
      reason,
      operatorId,
    });
  });
}

export async function operateProject(db: CampusDb, operatorId: string, body: Record<string, unknown>) {
  const id = text(body.id);
  const action = text(body.action);
  const reason = optionalText(body.reason);
  const version = intValue(body.version);
  requireBound(id, '业务id不能为空', 64, '业务id不能超过64字');
  requireBound(action, '操作动作不能为空', 32, '操作动作不能超过32字');
  if (version == null) throw campus(500, '版本号不能为空');
  if (version < 0) throw campus(500, '版本号不合法');
  if (!PROJECT_OPERATIONS.has(action)) throw campus(121010, '不支持的项目运营动作');
  if ((action === HIDE || action === SHOW) && !reason) throw campus(121010, '隐藏或恢复项目必须填写原因');
  const project = await requireProject(db, id);
  if (cellNumber(project, 'version') !== version) throw campus(121009, '项目已被更新，请刷新后重试');
  if ((action === SHOW || action === PIN) && cellText(project, 'status') !== APPROVED) {
    throw campus(121010, '未审核通过的项目不能展示或置顶');
  }
  const hidden = action === HIDE ? 1 : action === SHOW ? 0 : null;
  const pinned = action === PIN ? 1 : action === UNPIN ? 0 : null;
  await db.transaction().execute(async (trx) => {
    const updated = await executeAffected(
      trx,
      sql`UPDATE sc_campus_project
          SET hidden_flag = COALESCE(${hidden}, hidden_flag), pinned_flag = COALESCE(${pinned}, pinned_flag),
              version = ${version + 1}, update_time = ${new Date()}, update_user = ${operatorId}
          WHERE id = ${id} AND version = ${version} AND delete_flag = 'NOT_DELETE'`,
    );
    if (updated !== 1) throw campus(121009, '项目已被其他运营人员更新');
    await recordReview(trx, {
      businessType: PROJECT,
      businessId: id,
      version,
      action,
      beforeStatus: cellText(project, 'status') ?? '',
      afterStatus: cellText(project, 'status') ?? '',
      reason,
      operatorId,
    });
  });
}

function verificationResult(row: Row) {
  return {
    id: cellText(row, 'id'),
    profileId: cellText(row, 'profile_id'),
    identityType: cellText(row, 'identity_type'),
    realName: sm4Decrypt(row.real_name),
    orgName: cellText(row, 'org_name'),
    grade: cellText(row, 'grade'),
    proofDesc: cellText(row, 'proof_desc'),
    proofFileId: cellText(row, 'proof_file_id'),
    wechat: sm4Decrypt(row.wechat),
    status: cellText(row, 'status'),
    rejectReason: cellText(row, 'reject_reason'),
    submittedTime: asDate(row.submitted_time),
    reviewTime: asDate(row.review_time),
    versionNo: cellNumber(row, 'version_no'),
    version: cellNumber(row, 'version'),
  };
}

export async function myVerification(db: CampusDb, userId: string) {
  const latest = await latestVerification(db, userId);
  return latest ? verificationResult(latest) : null;
}

async function requireApprovedVerification(db: CampusDb, userId: string) {
  const latest = await latestVerification(db, userId);
  if (!latest) throw campus(121002, '请先完成身份认证');
  if (cellText(latest, 'status') === PENDING) throw campus(121003, '身份认证正在审核中');
  if (cellText(latest, 'status') !== APPROVED) throw campus(121004, '身份认证未通过');
  return latest;
}

export async function submitVerification(db: CampusDb, env: AppEnv, userId: string, body: Record<string, unknown>) {
  const identityType = text(body.identityType);
  const realName = text(body.realName);
  const orgName = text(body.orgName);
  const grade = text(body.grade);
  const proofDesc = text(body.proofDesc);
  const proofFileId = text(body.proofFileId);
  const wechat = text(body.wechat);
  requireBound(identityType, '认证身份不能为空', 32, '认证身份不能超过32字');
  requireBound(realName, '真实姓名或负责人姓名不能为空', 64, '姓名不能超过64字');
  requireBound(orgName, '认证组织不能为空', 128, '认证组织不能超过128字');
  limitLength(grade, 32, '年级不能超过32字');
  requireBound(proofDesc, '证明材料说明不能为空', 1000, '证明材料说明不能超过1000字');
  limitLength(proofFileId, 512, '证明材料文件标识不能超过512字');
  requireBound(wechat, '联系微信不能为空', 64, '联系微信不能超过64字');
  if (!ROLE_TYPES.has(identityType)) throw campus(121010, '认证身份不合法');
  if (identityType === AMBASSADOR && !grade) throw campus(121010, '校园大使认证必须填写年级');
  const profile = await profileByUser(db, userId);
  if (!profile) throw campus(121005, '请先提交主体名片');
  if (cellText(profile, 'role_type') !== identityType) throw campus(121006, '认证身份必须与名片身份一致');
  return withLock(env, `campus-circle:verification:submit:${userId}`, 3000, 15, '认证正在提交，请稍后重试', async () => {
    const latest = await latestVerification(db, userId);
    if (latest && cellText(latest, 'status') === PENDING) throw campus(121003, '认证正在审核中，请勿重复提交');
    if (latest && cellText(latest, 'status') === APPROVED) throw campus(121010, '认证已通过，无需重复提交');
    if (proofFileId) await claimOwnedFile(db, userId, FILE_VERIFICATION, proofFileId);
    const verificationId = newId();
    const created = {
      ...stamp(userId),
      id: verificationId,
      user_id: userId,
      profile_id: cellText(profile, 'id'),
      version_no: latest ? cellNumber(latest, 'version_no') + 1 : 1,
      identity_type: identityType,
      real_name: sm4Encrypt(realName),
      org_name: orgName,
      grade: grade || null,
      proof_desc: proofDesc,
      proof_file_id: proofFileId || null,
      wechat: sm4Encrypt(wechat),
      status: PENDING,
      reject_reason: null,
      submitted_time: new Date(),
      review_time: null,
      review_user_id: null,
      version: 0,
    };
    await insertRow(db, 'sc_campus_verification', created);
    return verificationId;
  });
}

export async function adminVerificationPage(db: CampusDb, query: Record<string, unknown>) {
  const status = text(query.status);
  const type = text(query.type);
  const keyword = text(query.keyword);
  limitLength(status, 32, '审核状态不能超过32字');
  limitLength(type, 32, '类型不能超过32字');
  limitLength(keyword, 64, '关键词不能超过64字');
  if (type && !ROLE_TYPES.has(type)) throw campus(121010, '认证身份不合法');
  const page = pageQuery(query, 20, 100);
  const filters = [sql`delete_flag = 'NOT_DELETE'`, latestVerificationFilter()];
  if (status) filters.push(sql`status = ${status}`);
  if (type) filters.push(sql`identity_type = ${type}`);
  if (keyword) filters.push(sql`org_name LIKE ${`%${keyword}%`}`);
  const where = sql.join(filters, sql` AND `);
  const total = await queryCount(db, sql`SELECT COUNT(*) AS total FROM sc_campus_verification WHERE ${where}`);
  const records = await queryRows(
    db,
    sql`SELECT * FROM sc_campus_verification WHERE ${where} ORDER BY submitted_time DESC LIMIT ${page.size} OFFSET ${page.offset}`,
  );
  return pageResult(records.map(verificationResult), total, page.current, page.size);
}

export async function adminVerificationDetail(db: CampusDb, id: string) {
  const verification = await queryOne(
    db,
    sql`SELECT * FROM sc_campus_verification WHERE delete_flag = 'NOT_DELETE' AND id = ${id} LIMIT 1`,
  );
  if (!verification) throw campus(121001, '认证申请不存在');
  const latest = await latestVerification(db, cellText(verification, 'user_id') ?? '');
  return verificationResult(latest ?? verification);
}

export async function reviewVerification(db: CampusDb, operatorId: string, body: Record<string, unknown>) {
  const id = text(body.id);
  const action = text(body.action);
  const reason = optionalText(body.reason);
  const version = intValue(body.version);
  requireBound(id, '业务id不能为空', 64, '业务id不能超过64字');
  requireBound(action, '审核动作不能为空', 32, '审核动作不能超过32字');
  if (version == null) throw campus(500, '版本号不能为空');
  if (version < 0) throw campus(500, '版本号不合法');
  if (!VERIFICATION_REVIEW_ACTIONS.has(action)) throw campus(121010, '不支持的认证审核动作');
  const reasonRequired = action === REJECT || action === REVOKE;
  if (reasonRequired && !reason) throw campus(121010, '拒绝或撤销原因不能为空');
  const verification = await queryOne(
    db,
    sql`SELECT * FROM sc_campus_verification WHERE delete_flag = 'NOT_DELETE' AND id = ${id} LIMIT 1`,
  );
  if (!verification) throw campus(121001, '认证申请不存在');
  const latest = await latestVerification(db, cellText(verification, 'user_id') ?? '');
  if (latest && cellText(latest, 'id') !== cellText(verification, 'id')) {
    throw campus(121009, '认证申请已被新版本替代，请刷新后重试');
  }
  if (cellNumber(verification, 'version') !== version) throw campus(121009, '认证申请已被其他运营人员更新');
  if (action === REVOKE) {
    if (cellText(verification, 'status') !== APPROVED) throw campus(121010, '只有已通过认证可以撤销');
  } else if (cellText(verification, 'status') !== PENDING) {
    throw campus(121010, '只有待审核认证可以通过或拒绝');
  }
  const profile = await requireProfile(db, cellText(verification, 'profile_id') ?? '');
  if (action === PASS && cellText(profile, 'role_type') !== cellText(verification, 'identity_type')) {
    throw campus(121006, '认证身份与当前名片身份不一致');
  }
  const afterStatus = action === PASS ? APPROVED : REJECTED;
  const now = new Date();
  await db.transaction().execute(async (trx) => {
    const updated = await executeAffected(
      trx,
      sql`UPDATE sc_campus_verification
          SET status = ${afterStatus}, reject_reason = ${reasonRequired ? reason : null},
              review_time = ${now}, review_user_id = ${operatorId}, version = ${version + 1},
              update_time = ${now}, update_user = ${operatorId}
          WHERE id = ${id} AND version = ${version} AND delete_flag = 'NOT_DELETE'`,
    );
    if (updated !== 1) throw campus(121009, '认证申请已被其他运营人员更新');
    if (action === REVOKE) {
      await sql`UPDATE sc_campus_profile
                SET vip_flag = 0, vip_expire_time = NULL, version = version + 1, update_time = ${now}, update_user = ${operatorId}
                WHERE id = ${cellText(profile, 'id')}`.execute(trx);
    }
    await recordReview(trx, {
      businessType: VERIFICATION,
      businessId: id,
      version,
      action,
      beforeStatus: cellText(verification, 'status') ?? '',
      afterStatus,
      reason,
      operatorId,
    });
  });
}

async function publicContactProfile(db: CampusDb, profileId: string) {
  const profile = await queryOne(db, sql`SELECT * FROM sc_campus_profile WHERE delete_flag = 'NOT_DELETE' AND id = ${profileId} LIMIT 1`);
  if (!profile || cellText(profile, 'status') !== APPROVED || flag(profile.hidden_flag)) {
    throw campus(121008, '联系人已下架');
  }
  return profile;
}

async function resolveContact(db: CampusDb, sourceType: string, sourceId: string) {
  if (sourceType === PROFILE) {
    const owner = await publicContactProfile(db, sourceId);
    const revision = await queryOne(
      db,
      sql`SELECT wechat, phone FROM sc_campus_profile_revision
          WHERE delete_flag = 'NOT_DELETE' AND id = ${cellText(owner, 'approved_revision_id')} LIMIT 1`,
    );
    return { owner, wechat: sm4Decrypt(revision?.wechat), phone: sm4Decrypt(revision?.phone) };
  }
  if (sourceType === PROJECT) {
    const project = await requireProject(db, sourceId);
    if (cellText(project, 'status') !== APPROVED || flag(project.hidden_flag)) throw campus(121008, '项目已下架');
    const owner = await publicContactProfile(db, cellText(project, 'profile_id') ?? '');
    return { owner, wechat: sm4Decrypt(project.wechat), phone: sm4Decrypt(project.phone) };
  }
  throw campus(121010, '联系方式来源类型不合法');
}

async function unlockedToday(db: CampusDb, userId: string, day: string) {
  return queryCount(
    db,
    sql`SELECT COUNT(*) AS total FROM sc_campus_contact_unlock
        WHERE delete_flag = 'NOT_DELETE' AND viewer_user_id = ${userId} AND unlock_date = ${day}`,
  );
}

function contactResult(profileId: string, wechat: string | null, phone: string | null, alreadyUnlocked: boolean, remainingToday: number) {
  return { profileId, wechat, phone, alreadyUnlocked, remainingToday };
}

export async function unlockContact(db: CampusDb, env: AppEnv, request: FastifyRequest, userId: string, body: Record<string, unknown>) {
  const sourceType = text(body.sourceType);
  const sourceId = text(body.sourceId);
  requireBound(sourceType, '来源类型不能为空', 32, '来源类型不能超过32字');
  requireBound(sourceId, '来源id不能为空', 64, '来源id不能超过64字');
  await requireApprovedVerification(db, userId);
  const day = shanghaiDay();
  try {
    return await withLock(env, `campus-circle:unlock:${userId}:${day}`, 3000, 20, '解锁请求处理中，请稍后重试', async () => {
      try {
        return await db.transaction().execute((trx) => doUnlock(trx, request, userId, day, sourceType, sourceId));
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'ER_DUP_ENTRY') return recoverUnlock(db, request, userId, day, sourceType, sourceId);
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof CampusError) {
      await recordSensitive(db, request, userId, sourceType, sourceId, 'UNLOCK', 'DENIED').catch(() => undefined);
    }
    throw error;
  }
}

async function doUnlock(db: CampusDb, request: FastifyRequest, userId: string, day: string, sourceType: string, sourceId: string) {
  const target = await resolveContact(db, sourceType, sourceId);
  if (userId === cellText(target.owner, 'user_id')) throw campus(121010, '本人联系方式请在我的名片中查看');
  const existing = await queryOne(
    db,
    sql`SELECT id FROM sc_campus_contact_unlock
        WHERE delete_flag = 'NOT_DELETE' AND viewer_user_id = ${userId}
          AND contact_owner_profile_id = ${cellText(target.owner, 'id')} AND unlock_date = ${day} LIMIT 1`,
  );
  const viewer = await profileByUser(db, userId);
  const vip = isVipActive(viewer);
  const used = await unlockedToday(db, userId, day);
  const ownerId = cellText(target.owner, 'id') ?? '';
  if (existing) {
    await recordSensitive(db, request, userId, sourceType, sourceId, 'UNLOCK', 'SUCCESS');
    return contactResult(ownerId, target.wechat, target.phone, true, vip ? -1 : Math.max(0, DAILY_UNLOCK_LIMIT - used));
  }
  if (!vip && used >= DAILY_UNLOCK_LIMIT) throw campus(121007, '今日联系方式查看次数已用完');
  await insertRow(db, 'sc_campus_contact_unlock', {
    ...stamp(userId),
    viewer_user_id: userId,
    contact_owner_profile_id: ownerId,
    source_type: sourceType,
    source_id: sourceId,
    unlock_date: day,
    vip_flag: vip ? 1 : 0,
    unlock_time: new Date(),
  });
  await recordSensitive(db, request, userId, sourceType, sourceId, 'UNLOCK', 'SUCCESS');
  return contactResult(ownerId, target.wechat, target.phone, false, vip ? -1 : Math.max(0, DAILY_UNLOCK_LIMIT - used - 1));
}

async function recoverUnlock(db: CampusDb, request: FastifyRequest, userId: string, day: string, sourceType: string, sourceId: string) {
  const target = await resolveContact(db, sourceType, sourceId);
  const existing = await queryOne(
    db,
    sql`SELECT id FROM sc_campus_contact_unlock
        WHERE delete_flag = 'NOT_DELETE' AND viewer_user_id = ${userId}
          AND contact_owner_profile_id = ${cellText(target.owner, 'id')} AND unlock_date = ${day} LIMIT 1`,
  );
  if (!existing) throw campus(121010, '解锁失败，请重试');
  const viewer = await profileByUser(db, userId);
  const vip = isVipActive(viewer);
  const used = await unlockedToday(db, userId, day);
  await recordSensitive(db, request, userId, sourceType, sourceId, 'UNLOCK', 'SUCCESS');
  return contactResult(cellText(target.owner, 'id') ?? '', target.wechat, target.phone, true, vip ? -1 : Math.max(0, DAILY_UNLOCK_LIMIT - used));
}

export async function todayContacts(db: CampusDb, userId: string) {
  const day = shanghaiDay();
  const rows = await queryRows(
    db,
    sql`SELECT * FROM sc_campus_contact_unlock
        WHERE delete_flag = 'NOT_DELETE' AND viewer_user_id = ${userId} AND unlock_date = ${day}
        ORDER BY unlock_time DESC`,
  );
  const results = [];
  for (const unlock of rows) {
    const profile = await queryOne(
      db,
      sql`SELECT * FROM sc_campus_profile WHERE delete_flag = 'NOT_DELETE' AND id = ${cellText(unlock, 'contact_owner_profile_id')} LIMIT 1`,
    );
    let available = !!profile && cellText(profile, 'status') === APPROVED && !flag(profile?.hidden_flag);
    const revisionId = profile ? cellText(profile, 'approved_revision_id') || cellText(profile, 'latest_revision_id') : '';
    const revision = revisionId
      ? await queryOne(db, sql`SELECT name, org_name FROM sc_campus_profile_revision WHERE delete_flag = 'NOT_DELETE' AND id = ${revisionId} LIMIT 1`)
      : undefined;
    let name = revision ? cellText(revision, 'name') : null;
    const orgName = revision ? cellText(revision, 'org_name') : null;
    if (cellText(unlock, 'source_type') === PROJECT) {
      const project = await queryOne(db, sql`SELECT title, status, hidden_flag FROM sc_campus_project WHERE delete_flag = 'NOT_DELETE' AND id = ${cellText(unlock, 'source_id')} LIMIT 1`);
      if (project) {
        name = cellText(project, 'title');
        available = available && cellText(project, 'status') === APPROVED && !flag(project.hidden_flag);
      }
    }
    results.push({
      sourceType: cellText(unlock, 'source_type'),
      sourceId: cellText(unlock, 'source_id'),
      profileId: cellText(unlock, 'contact_owner_profile_id'),
      name,
      orgName,
      unlockTime: asDate(unlock.unlock_time),
      contentAvailable: available,
    });
  }
  return results;
}

export async function copyContact(db: CampusDb, request: FastifyRequest, userId: string, body: Record<string, unknown>) {
  const sourceType = text(body.sourceType);
  const sourceId = text(body.sourceId);
  requireBound(sourceType, '来源类型不能为空', 32, '来源类型不能超过32字');
  requireBound(sourceId, '来源id不能为空', 64, '来源id不能超过64字');
  const target = await resolveContact(db, sourceType, sourceId);
  const count = await queryCount(
    db,
    sql`SELECT COUNT(*) AS total FROM sc_campus_contact_unlock
        WHERE delete_flag = 'NOT_DELETE' AND viewer_user_id = ${userId}
          AND contact_owner_profile_id = ${cellText(target.owner, 'id')} AND unlock_date = ${shanghaiDay()}`,
  );
  if (count === 0) {
    await recordSensitive(db, request, userId, sourceType, sourceId, 'COPY', 'DENIED');
    throw campus(121010, '请先解锁联系方式');
  }
  await recordSensitive(db, request, userId, sourceType, sourceId, 'COPY', 'SUCCESS');
}

export async function submitRating(db: CampusDb, env: AppEnv, request: FastifyRequest, userId: string, body: Record<string, unknown>) {
  const profileId = text(body.profileId);
  const score = intValue(body.score);
  requireBound(profileId, '名片id不能为空', 64, '名片id不能超过64字');
  if (score == null) throw campus(500, '评分不能为空');
  if (score < 1) throw campus(500, '评分不能低于1星');
  if (score > 5) throw campus(500, '评分不能高于5星');
  await requireApprovedVerification(db, userId);
  const profile = await publicContactProfile(db, profileId);
  if (userId === cellText(profile, 'user_id')) throw campus(121010, '不能给自己的名片评分');
  const unlockCount = await queryCount(
    db,
    sql`SELECT COUNT(*) AS total FROM sc_campus_contact_unlock
        WHERE delete_flag = 'NOT_DELETE' AND viewer_user_id = ${userId} AND contact_owner_profile_id = ${profileId}`,
  );
  if (unlockCount === 0) throw campus(121010, '解锁该联系人后才能评分');
  await withLock(env, `campus-circle:rating:${profileId}:${userId}`, 3000, 15, '评分正在提交，请稍后重试', () =>
    db.transaction().execute(async (trx) => {
      const existing = await queryOne(
        trx,
        sql`SELECT * FROM sc_campus_rating
            WHERE delete_flag = 'NOT_DELETE' AND profile_id = ${profileId} AND rater_user_id = ${userId} LIMIT 1`,
      );
      let totalDelta = 0;
      let countDelta = 0;
      let auditAction = 'RATE_CREATE';
      if (!existing) {
        await insertRow(trx, 'sc_campus_rating', {
          ...stamp(userId),
          profile_id: profileId,
          rater_user_id: userId,
          score,
          visible_flag: 1,
          hidden_reason: null,
          version: 0,
        });
        totalDelta = score;
        countDelta = 1;
      } else {
        const start = shanghaiStart();
        const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
        const updates = await queryCount(
          trx,
          sql`SELECT COUNT(*) AS total FROM sc_campus_sensitive_access_log
              WHERE delete_flag = 'NOT_DELETE' AND user_id = ${userId} AND action = 'RATE_UPDATE'
                AND operation_time >= ${start} AND operation_time < ${end}`,
        );
        if (updates >= 3) throw campus(121013, '今日评分修改次数已达上限');
        totalDelta = flag(existing.visible_flag) ? score - cellNumber(existing, 'score') : 0;
        const updated = await executeAffected(
          trx,
          sql`UPDATE sc_campus_rating SET score = ${score}, version = ${cellNumber(existing, 'version') + 1},
                  update_time = ${new Date()}, update_user = ${userId}
              WHERE id = ${cellText(existing, 'id')} AND version = ${cellNumber(existing, 'version')}`,
        );
        if (updated !== 1) throw campus(121009, '评分已被更新，请重试');
        auditAction = 'RATE_UPDATE';
      }
      if (totalDelta !== 0 || countDelta !== 0) {
        await sql`UPDATE sc_campus_profile
                  SET rating_total = rating_total + (${totalDelta}), rating_count = rating_count + (${countDelta}),
                      version = version + 1
                  WHERE id = ${profileId}`.execute(trx);
      }
      await recordSensitive(trx, request, userId, PROFILE, profileId, auditAction, 'SUCCESS');
    }),
  );
}

export async function adminRatingPage(db: CampusDb, query: Record<string, unknown>) {
  const keyword = text(query.keyword);
  limitLength(keyword, 64, '关键词不能超过64字');
  const page = pageQuery(query, 20, 100);
  const filters = [sql`delete_flag = 'NOT_DELETE'`];
  if (keyword) filters.push(sql`profile_id = ${keyword}`);
  const where = sql.join(filters, sql` AND `);
  const total = await queryCount(db, sql`SELECT COUNT(*) AS total FROM sc_campus_rating WHERE ${where}`);
  const records = await queryRows(
    db,
    sql`SELECT * FROM sc_campus_rating WHERE ${where} ORDER BY create_time DESC LIMIT ${page.size} OFFSET ${page.offset}`,
  );
  return pageResult(
    records.map((row) => ({
      id: cellText(row, 'id'),
      profileId: cellText(row, 'profile_id'),
      raterUserId: cellText(row, 'rater_user_id'),
      score: cellNumber(row, 'score'),
      visible: flag(row.visible_flag),
      hiddenReason: cellText(row, 'hidden_reason'),
      version: cellNumber(row, 'version'),
      createTime: asDate(row.create_time),
      updateTime: asDate(row.update_time),
    })),
    total,
    page.current,
    page.size,
  );
}

export async function hideRating(db: CampusDb, operatorId: string, body: Record<string, unknown>) {
  const id = text(body.id);
  const version = intValue(body.version);
  const visible = body.visible === true || body.visible === 'true' || body.visible === 1;
  const reason = optionalText(body.reason);
  requireBound(id, '评分id不能为空', 64, '评分id不能超过64字');
  if (version == null) throw campus(500, '版本号不能为空');
  if (version < 0) throw campus(500, '版本号不合法');
  if (body.visible == null) throw campus(500, '显示状态不能为空');
  if (!visible && !reason) throw campus(121010, '隐藏评分必须填写原因');
  await db.transaction().execute(async (trx) => {
    const rating = await queryOne(trx, sql`SELECT * FROM sc_campus_rating WHERE delete_flag = 'NOT_DELETE' AND id = ${id} LIMIT 1`);
    if (!rating) throw campus(121001, '评分不存在');
    if (cellNumber(rating, 'version') !== version) throw campus(121009, '评分已被其他运营人员更新');
    if (flag(rating.visible_flag) === visible) return;
    const updated = await executeAffected(
      trx,
      sql`UPDATE sc_campus_rating
          SET visible_flag = ${visible ? 1 : 0}, hidden_reason = ${visible ? null : reason}, version = ${version + 1},
              update_time = ${new Date()}, update_user = ${operatorId}
          WHERE id = ${id} AND version = ${version}`,
    );
    if (updated !== 1) throw campus(121009, '评分已被其他运营人员更新');
    const direction = visible ? 1 : -1;
    await sql`UPDATE sc_campus_profile
              SET rating_total = rating_total + (${direction * cellNumber(rating, 'score')}),
                  rating_count = rating_count + (${direction}), version = version + 1
              WHERE id = ${cellText(rating, 'profile_id')}`.execute(trx);
    await recordReview(trx, {
      businessType: RATING,
      businessId: id,
      version,
      action: visible ? SHOW : HIDE,
      beforeStatus: String(flag(rating.visible_flag)),
      afterStatus: String(visible),
      reason,
      operatorId,
    });
  });
}

const DEFAULT_CONTENT = {
  serviceWechat: 'xiaolian_kefu',
  businessEmail: 'bd@xiaolian.cn',
  serviceHours: '工作时间 9:00 - 21:00',
  serviceNotice: '入驻、认证和合作问题均可咨询',
  aboutContent:
    '校园市场圈是一个连接校园大使、校园社团与品牌方的资源对接平台。\n\n📇 校园人脉：像通讯录一样查找伙伴，每天可解锁 3 位联系人（VIP 不限次数）。\n🤝 找赞助：社团发布活动信息，审核通过后对接品牌赞助。\n📣 找大使：企业发布招募与推广信息，直达全国高校。',
  vipSummary: '不限次数查看所有伙伴的联系方式 · 专属金色标识',
  vipBenefits: '👑 不限次数查看所有伙伴的联系方式\n🏅 名片专属金色 VIP 标识\n🚀 名片与发布项目优先推荐',
  vipApplyGuide: '添加下方客服微信，发送「开通VIP + 你的名片名称」，工作人员核实身份后将在后台手动为你开通（需先完成身份认证）。',
  version: 0,
};

function contentResult(row: Row) {
  return {
    serviceWechat: cellText(row, 'service_wechat'),
    businessEmail: cellText(row, 'business_email'),
    serviceHours: cellText(row, 'service_hours'),
    serviceNotice: cellText(row, 'service_notice'),
    aboutContent: cellText(row, 'about_content'),
    vipSummary: cellText(row, 'vip_summary'),
    vipBenefits: cellText(row, 'vip_benefits'),
    vipApplyGuide: cellText(row, 'vip_apply_guide'),
    version: cellNumber(row, 'version'),
  };
}

export async function platformContent(db: CampusDb) {
  const row = await queryOne(db, sql`SELECT * FROM sc_campus_platform_content WHERE delete_flag = 'NOT_DELETE' AND id = ${CONTENT_ID} LIMIT 1`);
  return row ? contentResult(row) : DEFAULT_CONTENT;
}

export async function savePlatformContent(db: CampusDb, operatorId: string, body: Record<string, unknown>) {
  const version = intValue(body.version);
  if (version == null) throw campus(500, '版本号不能为空');
  if (version < 0) throw campus(500, '版本号不合法');
  const values = {
    serviceWechat: text(body.serviceWechat),
    businessEmail: optionalText(body.businessEmail),
    serviceHours: text(body.serviceHours),
    serviceNotice: optionalText(body.serviceNotice),
    aboutContent: text(body.aboutContent),
    vipSummary: text(body.vipSummary),
    vipBenefits: text(body.vipBenefits),
    vipApplyGuide: text(body.vipApplyGuide),
  };
  requireBound(values.serviceWechat, '客服微信不能为空', 64, '客服微信不能超过64字');
  limitLength(values.businessEmail ?? '', 128, '商务邮箱不能超过128字');
  requireBound(values.serviceHours, '客服工作时间不能为空', 128, '客服工作时间不能超过128字');
  limitLength(values.serviceNotice ?? '', 500, '客服说明不能超过500字');
  requireBound(values.aboutContent, '平台介绍不能为空', 3000, '平台介绍不能超过3000字');
  requireBound(values.vipSummary, 'VIP 概要不能为空', 256, 'VIP 概要不能超过256字');
  requireBound(values.vipBenefits, 'VIP 权益不能为空', 1500, 'VIP 权益不能超过1500字');
  requireBound(values.vipApplyGuide, 'VIP 开通说明不能为空', 1500, 'VIP 开通说明不能超过1500字');
  const current = await queryOne(db, sql`SELECT * FROM sc_campus_platform_content WHERE id = ${CONTENT_ID} LIMIT 1`);
  const now = new Date();
  if (!current) {
    if (version !== 0) throw campus(121009, '前台内容已被其他运营人员更新，请刷新后重试');
    await insertRow(db, 'sc_campus_platform_content', {
      id: CONTENT_ID,
      service_wechat: values.serviceWechat,
      business_email: values.businessEmail,
      service_hours: values.serviceHours,
      service_notice: values.serviceNotice,
      about_content: values.aboutContent,
      vip_summary: values.vipSummary,
      vip_benefits: values.vipBenefits,
      vip_apply_guide: values.vipApplyGuide,
      version: 0,
      delete_flag: 'NOT_DELETE',
      create_time: now,
      create_user: operatorId,
      update_time: null,
      update_user: null,
    });
    return { ...values, version: 0 };
  }
  if (cellNumber(current, 'version') !== version) throw campus(121009, '前台内容已被其他运营人员更新，请刷新后重试');
  const updated = await executeAffected(
    db,
    sql`UPDATE sc_campus_platform_content
        SET service_wechat = ${values.serviceWechat}, business_email = ${values.businessEmail},
            service_hours = ${values.serviceHours}, service_notice = ${values.serviceNotice},
            about_content = ${values.aboutContent}, vip_summary = ${values.vipSummary},
            vip_benefits = ${values.vipBenefits}, vip_apply_guide = ${values.vipApplyGuide},
            version = ${version + 1}, update_time = ${now}, update_user = ${operatorId}
        WHERE id = ${CONTENT_ID} AND version = ${version}`,
  );
  if (updated !== 1) throw campus(121009, '前台内容已被其他运营人员更新，请刷新后重试');
  return { ...values, version: version + 1 };
}

export async function meSummary(db: CampusDb, userId: string) {
  const profile = await profileByUser(db, userId);
  const verification = await latestVerification(db, userId);
  const used = await unlockedToday(db, userId, shanghaiDay());
  const vip = isVipActive(profile);
  const projectCount = await queryCount(
    db,
    sql`SELECT COUNT(*) AS total FROM sc_campus_project WHERE delete_flag = 'NOT_DELETE' AND publisher_user_id = ${userId}`,
  );
  return {
    profileId: profile ? cellText(profile, 'id') : null,
    profileStatus: profile ? cellText(profile, 'status') : null,
    roleType: profile ? cellText(profile, 'role_type') : null,
    verificationStatus: verification ? cellText(verification, 'status') : 'UNSUBMITTED',
    vip,
    vipExpireTime: profile ? asDate(profile.vip_expire_time) : null,
    dailyLimit: vip ? -1 : DAILY_UNLOCK_LIMIT,
    unlockedToday: used,
    remainingToday: vip ? -1 : Math.max(0, DAILY_UNLOCK_LIMIT - used),
    publishedProjectCount: projectCount,
  };
}

export async function adminDashboard(db: CampusDb) {
  const pendingVerificationCount = await queryCount(
    db,
    sql`SELECT COUNT(*) AS total FROM sc_campus_verification WHERE delete_flag = 'NOT_DELETE' AND status = ${PENDING} AND ${latestVerificationFilter()}`,
  );
  const countProfile = async (extra: ReturnType<typeof sql>) =>
    queryCount(db, sql`SELECT COUNT(*) AS total FROM sc_campus_profile WHERE delete_flag = 'NOT_DELETE' AND ${extra}`);
  return {
    pendingVerificationCount,
    profileCount: await queryCount(db, sql`SELECT COUNT(*) AS total FROM sc_campus_profile WHERE delete_flag = 'NOT_DELETE'`),
    pendingProfileCount: await countProfile(sql`status = ${PENDING}`),
    vipProfileCount: await countProfile(sql`vip_flag = 1 AND (vip_expire_time IS NULL OR vip_expire_time > NOW())`),
    pinnedProfileCount: await countProfile(sql`pinned_flag = 1`),
    projectCount: await queryCount(db, sql`SELECT COUNT(*) AS total FROM sc_campus_project WHERE delete_flag = 'NOT_DELETE'`),
    pendingProjectCount: await queryCount(
      db,
      sql`SELECT COUNT(*) AS total FROM sc_campus_project WHERE delete_flag = 'NOT_DELETE' AND status = ${PENDING}`,
    ),
    todayUniqueUnlockCount: await queryCount(
      db,
      sql`SELECT COUNT(*) AS total FROM sc_campus_contact_unlock WHERE delete_flag = 'NOT_DELETE' AND unlock_date = ${shanghaiDay()}`,
    ),
  };
}

export async function sitemapPage(db: CampusDb, query: Record<string, unknown>) {
  const cursor = text(query.cursor);
  limitLength(cursor, 64, '游标长度不能超过64字');
  const size = query.size == null || query.size === '' ? 200 : Number(query.size);
  if (!Number.isInteger(size) || size < 1) throw campus(500, '每页数量不能小于1');
  if (size > 500) throw campus(500, '每页数量不能超过500');
  const fetchSize = size + 1;
  const profileFilter = cursor ? sql`AND id > ${cursor}` : sql``;
  const projectFilter = cursor ? sql`AND id > ${cursor}` : sql``;
  const profiles = await queryRows(
    db,
    sql`SELECT id, update_time, approved_time, create_time FROM sc_campus_profile
        WHERE delete_flag = 'NOT_DELETE' AND status = ${APPROVED} AND hidden_flag = 0 ${profileFilter}
        ORDER BY id ASC LIMIT ${fetchSize}`,
  );
  const projects = await queryRows(
    db,
    sql`SELECT id, update_time, approved_time, create_time FROM sc_campus_project
        WHERE delete_flag = 'NOT_DELETE' AND status = ${APPROVED} AND hidden_flag = 0
          AND ${publicProjectExists()} ${projectFilter}
        ORDER BY id ASC LIMIT ${fetchSize}`,
  );
  const items = [
    ...profiles.map((row) => ({
      id: cellText(row, 'id'),
      type: PROFILE,
      lastModified: asDate(row.update_time) ?? asDate(row.approved_time) ?? asDate(row.create_time),
    })),
    ...projects.map((row) => ({
      id: cellText(row, 'id'),
      type: PROJECT,
      lastModified: asDate(row.update_time) ?? asDate(row.approved_time) ?? asDate(row.create_time),
    })),
  ].sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const hasMore = items.length > size;
  const records = items.slice(0, size);
  return { records, nextCursor: hasMore && records.length > 0 ? records[records.length - 1]?.id ?? null : null };
}

export async function auditPage(db: CampusDb, query: Record<string, unknown>) {
  const type = text(query.type);
  const keyword = text(query.keyword);
  limitLength(type, 32, '类型不能超过32字');
  limitLength(keyword, 64, '关键词不能超过64字');
  const page = pageQuery(query, 20, 100);
  const filters = [sql`delete_flag = 'NOT_DELETE'`];
  if (type) filters.push(sql`business_type = ${type}`);
  if (keyword) filters.push(sql`business_id = ${keyword}`);
  const where = sql.join(filters, sql` AND `);
  const total = await queryCount(db, sql`SELECT COUNT(*) AS total FROM sc_campus_review_log WHERE ${where}`);
  const records = await queryRows(
    db,
    sql`SELECT * FROM sc_campus_review_log WHERE ${where} ORDER BY operation_time DESC LIMIT ${page.size} OFFSET ${page.offset}`,
  );
  return pageResult(
    records.map((row) => ({
      id: cellText(row, 'id'),
      businessType: cellText(row, 'business_type'),
      businessId: cellText(row, 'business_id'),
      businessVersion: cellNumber(row, 'business_version'),
      action: cellText(row, 'action'),
      beforeStatus: cellText(row, 'before_status'),
      afterStatus: cellText(row, 'after_status'),
      reason: cellText(row, 'reason'),
      operatorId: cellText(row, 'operator_id'),
      operationTime: asDate(row.operation_time),
    })),
    total,
    page.current,
    page.size,
  );
}

function imageMime(buffer: Buffer, filename: string) {
  const suffix = filename.split('.').pop()?.toLowerCase() ?? '';
  if (!['jpg', 'jpeg', 'png', 'webp'].includes(suffix)) throw campus(121011, '仅支持JPG、PNG和WebP图片');
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const png = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  const webp = buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  const mime = jpeg ? 'image/jpeg' : png ? 'image/png' : webp ? 'image/webp' : '';
  if (!mime) throw campus(121011, '图片实际格式不合法');
  const matched =
    (mime === 'image/jpeg' && (suffix === 'jpg' || suffix === 'jpeg')) ||
    (mime === 'image/png' && suffix === 'png') ||
    (mime === 'image/webp' && suffix === 'webp');
  if (!matched) throw campus(121011, '图片扩展名与实际格式不一致');
  return mime;
}

export async function uploadCampusFile(db: CampusDb, env: AppEnv, userId: string, scene: string, filename: string, buffer: Buffer) {
  const normalized = scene.trim().toUpperCase();
  if (!FILE_SCENES.has(normalized)) throw campus(121011, '文件上传场景不合法');
  if (!filename) throw campus(121011, '图片文件名不能为空');
  if (buffer.length === 0) throw campus(121011, '上传图片不能为空');
  const maxBytes = normalized === FILE_AVATAR ? 5_242_880 : 10_485_760;
  if (buffer.length > maxBytes) throw campus(121011, '图片大小超过限制');
  const mime = imageMime(buffer, filename);
  const fileRef = await uploadToCos(env, buffer, mime, filename);
  await insertRow(db, 'sc_campus_upload_file', {
    ...stamp(userId),
    user_id: userId,
    scene: normalized,
    file_ref: fileRef,
    file_ref_hash: sha256(fileRef),
    used_flag: 0,
    used_time: null,
  });
  return { scene: normalized, fileRef, fileUrl: fileRef, privateFile: false };
}

export { newId };
