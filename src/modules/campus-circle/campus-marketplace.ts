import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { sql } from 'kysely';
import { identityVerification, myProfile } from '@/modules/campus-circle/campus-domain.js';
import {
  APPROVED,
  asDate,
  campus,
  cellNumber,
  cellText,
  executeAffected,
  flag,
  insertRow,
  intValue,
  newId,
  queryCount,
  queryOne,
  queryRows,
  shanghaiDay,
  sm4Decrypt,
  sm4Encrypt,
  stamp,
  text,
  type CampusDb,
  type Row,
} from '@/modules/campus-circle/campus-support.js';

const DEMAND_TYPES = new Set(['PROJECT', 'CHANNEL']);
const DEMAND_CATEGORIES = new Set(['品牌推广', '活动执行', '用户拉新', '内容传播', '社群运营', '校园赞助', '其他']);
const SETTLEMENTS = new Set(['按项目结算', '按效果结算（CPS / CPA）', '按场次结算', '资源互换', '面议']);
const MATERIAL_CATEGORIES = new Set(['活动策划', '社团运营', '校园营销', '学习汇报', '求职就业', '其他']);
const CASE_CATEGORIES = new Set(['校园营销', '校园赞助']);
const CASE_STATUSES = new Set(['draft', 'published', 'offline']);
const PROVIDER_SERVICES = [
  '整合营销',
  '活动策划与执行',
  '校园地推',
  '校园媒体投放',
  '校园社群运营',
  '内容创作',
  '校园赛事',
  '其他服务',
];
const PROVIDER_IMAGE_PREFIX = '/api/cases/images/';
const MEDIA_IMAGE_PREFIX = '/api/mock/advertising/images/';
const IMAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PHONE = /^[+\d][\d\s()-]{5,29}$/;
const MOBILE = /^1[3-9]\d{9}$/;
const MATERIAL_LIMIT = 20 * 1024 * 1024;
const IMAGE_LIMIT = 5 * 1024 * 1024;

export type UploadFile = { filename: string; mimetype: string; buffer: Buffer };
export type StoredFile = { bytes: Buffer; contentType: string; filename?: string; extension?: string };

function invalid(message: string) {
  return campus(121010, message);
}

function blank(value: unknown) {
  return value == null ? '' : String(value);
}

function alive() {
  return sql`delete_flag = 'NOT_DELETE'`;
}

function between(value: string, min: number, max: number, message: string) {
  if (value.length < min || value.length > max) throw invalid(message);
  return value;
}

function atMost(value: string, max: number, message: string) {
  if (value.length > max) throw invalid(message);
  return value;
}

function requiredVersion(value: unknown) {
  if (value == null || value === '') throw invalid('版本号不能为空');
  const parsed = intValue(value);
  if (parsed == null || parsed < 1) throw invalid('版本号不合法');
  return parsed;
}

function shanghaiDateTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${read('year')}-${read('month')}-${read('day')} ${read('hour')}:${read('minute')}:${read('second')}`;
}

function storageDir(folder: string, envName: string) {
  const configured = process.env[envName]?.trim();
  return configured || join(homedir(), '.campus-circle', folder);
}

function containedPath(directory: string, name: string) {
  const root = resolve(directory);
  const target = resolve(root, name);
  if (target !== root && !target.startsWith(root + sep)) throw invalid('文件标识不合法');
  return target;
}

async function reload(db: CampusDb, table: string, id: string) {
  const row = await queryOne(db, sql`SELECT * FROM ${sql.raw(table)} WHERE id = ${id} AND ${alive()} LIMIT 1`);
  if (!row) throw campus(121001, '记录不存在');
  return row;
}

function parseJson(value: unknown) {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value)) as unknown;
  } catch {
    return null;
  }
}

function stableJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object') {
      const source = item as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) sorted[key] = normalize(source[key]);
      return sorted;
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

function objectOf(value: unknown) {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item));
}

function longId(value: unknown) {
  if (value == null || value === '') return null;
  const number = typeof value === 'bigint' ? Number(value) : Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

export function isWechatArticle(value: string) {
  try {
    const uri = new URL(value);
    return (
      uri.protocol === 'https:' &&
      uri.hostname === 'mp.weixin.qq.com' &&
      uri.username === '' &&
      uri.password === '' &&
      uri.port === '' &&
      (uri.pathname === '/s' || uri.pathname.startsWith('/s/'))
    );
  } catch {
    return false;
  }
}

export function isCaseArticle(value: string) {
  const prefix = 'https://mp.weixin.qq.com/s';
  if (!value || value.length > 2000 || !value.startsWith(prefix)) return false;
  const rest = value.slice(prefix.length);
  return rest.length === 0 || rest.startsWith('/') || rest.startsWith('?');
}

export function isPresentation(bytes: Buffer, extension: string) {
  if (extension === 'pptx') {
    const latin = bytes.toString('latin1');
    return bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) && latin.includes('ppt/presentation.xml') && latin.includes('[Content_Types].xml');
  }
  if (extension === 'ppt') {
    return (
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) &&
      bytes.toString('utf16le').includes('PowerPoint Document')
    );
  }
  return false;
}

export function assertQuote(value: unknown) {
  const raw = typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) throw invalid('报价需为 0.01–99999999 的数字，最多两位小数');
  const amount = Number(raw);
  if (amount < 0.01 || amount > 99_999_999) throw invalid('报价需为 0.01–99999999 的数字，最多两位小数');
  return amount;
}

function imageType(buffer: Buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer.length >= 16 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    const chunk = buffer.subarray(12, 16).toString('ascii');
    if (chunk === 'VP8 ' || chunk === 'VP8L' || chunk === 'VP8X') return 'image/webp';
  }
  return '';
}

function requireImage(file: UploadFile | undefined) {
  if (!file || file.buffer.length === 0) throw campus(121011, '请选择图片');
  if (file.buffer.length > IMAGE_LIMIT) throw campus(121011, '每张图片不能超过 5 MB');
  const type = imageType(file.buffer);
  const extension = file.filename.includes('.') ? file.filename.slice(file.filename.lastIndexOf('.') + 1).toLowerCase() : '';
  const matched =
    (type === 'image/jpeg' && (extension === 'jpg' || extension === 'jpeg')) ||
    (type === 'image/png' && extension === 'png') ||
    (type === 'image/webp' && extension === 'webp');
  if (!type || !matched) throw campus(121011, '仅支持有效的 JPG、PNG、WebP 图片');
  const declared = file.mimetype.toLowerCase();
  if (declared && declared !== 'application/octet-stream' && declared !== type) {
    throw campus(121011, '仅支持有效的 JPG、PNG、WebP 图片');
  }
  return type;
}

async function writeNamedFile(directory: string, name: string, bytes: Buffer) {
  await mkdir(directory, { recursive: true });
  const target = containedPath(directory, name);
  await writeFile(target, bytes);
  return target;
}

async function readNamedFile(directory: string, name: string) {
  const target = containedPath(directory, name);
  try {
    return await readFile(target);
  } catch {
    throw campus(121001, '图片文件不存在');
  }
}

function demandPublic(row: Row) {
  const created = asDate(row.create_time);
  return {
    id: cellText(row, 'id'),
    type: cellText(row, 'demand_type'),
    title: cellText(row, 'title'),
    organization: cellText(row, 'organization'),
    category: cellText(row, 'category'),
    region: cellText(row, 'region'),
    scale: blank(cellText(row, 'scale_text')),
    resources: blank(cellText(row, 'resources')),
    requirements: cellText(row, 'requirements'),
    description: cellText(row, 'description'),
    budget: cellText(row, 'budget'),
    settlement: cellText(row, 'settlement'),
    period: blank(cellText(row, 'period_text')),
    deadline: cellText(row, 'deadline'),
    status: cellText(row, 'status'),
    createdAt: created,
    updatedAt: asDate(row.update_time) ?? created,
    version: cellNumber(row, 'version'),
  };
}

function parseHistory(value: unknown) {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item) => {
    const record = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    return { action: blank(record.action), reason: blank(record.reason), at: blank(record.at) };
  });
}

function demandRecord(row: Row) {
  return {
    ...demandPublic(row),
    contactName: blank(cellText(row, 'contact_name')),
    wechat: blank(sm4Decrypt(row.wechat)),
    phone: blank(sm4Decrypt(row.phone)),
    reason: blank(cellText(row, 'reason')),
    history: parseHistory(row.history_json),
  };
}

function demandAvailable(today: string) {
  return [alive(), sql`status = 'published'`, sql`deadline >= ${today}`];
}

function demandFilters(query: Record<string, unknown>, today: string) {
  const filters = demandAvailable(today);
  const type = text(query.type);
  if (type && type !== 'all') {
    if (type.length > 32) throw invalid('需求类型不合法');
    if (!DEMAND_TYPES.has(type)) throw invalid('需求类型不合法');
    filters.push(sql`demand_type = ${type}`);
  }
  const category = text(query.category);
  if (category) filters.push(sql`category = ${category}`);
  const region = text(query.region);
  if (region) filters.push(sql`region LIKE ${`%${region}%`}`);
  const keyword = text(query.keyword);
  if (keyword) {
    const like = `%${keyword}%`;
    filters.push(sql`(title LIKE ${like} OR organization LIKE ${like} OR description LIKE ${like} OR resources LIKE ${like} OR requirements LIKE ${like})`);
  }
  return filters;
}

function demandWindow(query: Record<string, unknown>) {
  const currentRaw = Number(query.current);
  const sizeRaw = Number(query.size);
  const current = Number.isFinite(currentRaw) ? Math.max(1, Math.trunc(currentRaw)) : 1;
  const size = !Number.isFinite(sizeRaw) || sizeRaw <= 0 ? 12 : Math.min(Math.trunc(sizeRaw), 30);
  return { current, size };
}

async function demandPage(db: CampusDb, filters: ReturnType<typeof sql>[], current: number, size: number) {
  const where = sql.join(filters, sql` AND `);
  const total = await queryCount(db, sql`SELECT COUNT(*) AS total FROM sc_campus_demand WHERE ${where}`);
  const pages = total <= 0 ? 1 : Math.ceil(total / size);
  const page = Math.min(pages, current);
  const records = await queryRows(
    db,
    sql`SELECT * FROM sc_campus_demand WHERE ${where} ORDER BY update_time DESC, create_time DESC LIMIT ${size} OFFSET ${(page - 1) * size}`,
  );
  return { records, total, current: total <= 0 ? 1 : page, pages, size };
}

export async function publicDemandPage(db: CampusDb, query: Record<string, unknown>) {
  const today = shanghaiDay();
  const window = demandWindow(query);
  const page = await demandPage(db, demandFilters(query, today), window.current, window.size);
  const count = (type: string) =>
    queryCount(db, sql`SELECT COUNT(*) AS total FROM sc_campus_demand WHERE ${sql.join([...demandAvailable(today), sql`demand_type = ${type}`], sql` AND `)}`);
  return {
    records: page.records.map(demandPublic),
    current: page.current,
    pages: page.pages,
    total: page.total,
    size: page.size,
    counts: { PROJECT: await count('PROJECT'), CHANNEL: await count('CHANNEL') },
  };
}

function demandOpen(row: Row | undefined, today: string) {
  return Boolean(row && cellText(row, 'status') === 'published' && (cellText(row, 'deadline') ?? '') >= today);
}

export async function publicDemandDetail(db: CampusDb, id: string) {
  const row = await queryOne(db, sql`SELECT * FROM sc_campus_demand WHERE id = ${id} AND ${alive()} LIMIT 1`);
  if (!demandOpen(row, shanghaiDay())) throw campus(121001, '需求不存在、尚未上线或已截止');
  return demandPublic(row as Row);
}

export async function publicDemandContact(db: CampusDb, id: string) {
  const row = await queryOne(db, sql`SELECT * FROM sc_campus_demand WHERE id = ${id} AND ${alive()} LIMIT 1`);
  if (!demandOpen(row, shanghaiDay())) throw campus(121001, '需求已下线或截止，暂不可联系');
  return {
    contactName: cellText(row, 'contact_name'),
    wechat: sm4Decrypt(row?.wechat),
    phone: blank(sm4Decrypt(row?.phone)),
  };
}

export async function myDemands(db: CampusDb, userId: string) {
  const rows = await queryRows(
    db,
    sql`SELECT * FROM sc_campus_demand WHERE ${alive()} AND user_id = ${userId} ORDER BY update_time DESC, create_time DESC`,
  );
  return rows.map(demandRecord);
}

export async function adminDemandList(db: CampusDb) {
  const rows = await queryRows(db, sql`SELECT * FROM sc_campus_demand WHERE ${alive()} ORDER BY update_time DESC, create_time DESC`);
  return rows.map(demandRecord);
}

function demandInput(body: Record<string, unknown>) {
  const type = text(body.type);
  const category = text(body.category);
  const settlement = text(body.settlement);
  if (!type) throw invalid('请选择需求类型');
  if (type.length > 32) throw invalid('需求类型不合法');
  if (!DEMAND_TYPES.has(type)) throw invalid('请选择需求类型');
  if (!category) throw invalid('请选择合作方向');
  if (category.length > 32) throw invalid('合作方向不合法');
  if (!DEMAND_CATEGORIES.has(category)) throw invalid('请选择合作方向');
  if (!settlement) throw invalid('请选择结算方式');
  if (settlement.length > 64) throw invalid('结算方式不合法');
  if (!SETTLEMENTS.has(settlement)) throw invalid('请选择结算方式');
  const title = between(text(body.title), 5, 80, '标题至少填写 5 个字');
  const organization = between(text(body.organization), 2, 80, '请填写发布主体');
  const region = between(text(body.region), 2, 80, '请填写覆盖地区');
  const scale = between(text(body.scale), 2, 80, '请填写覆盖规模');
  const resources = atMost(text(body.resources), 600, '资源介绍不能超过600字');
  if (type === 'PROJECT' && resources.length < 10) throw invalid('请至少用 10 个字介绍可提供的校园资源');
  const requirements = between(text(body.requirements), 10, 1000, '合作要求至少填写 10 个字');
  const description = between(text(body.description), 20, 2000, '需求详情至少填写 20 个字');
  const budget = text(body.budget);
  if (!budget || budget.length > 80) throw invalid('请填写预算，可填写面议');
  const period = between(text(body.period), 2, 80, '请填写合作排期');
  const deadline = text(body.deadline);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline) || deadline < shanghaiDay()) throw invalid('截止日期需为今天或以后的有效日期');
  const [year, month, day] = deadline.split('-').map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw invalid('截止日期需为今天或以后的有效日期');
  }
  const contactName = between(text(body.contactName), 2, 30, '请填写联系人');
  const wechat = text(body.wechat);
  if (!wechat || wechat.length > 64) throw invalid(wechat ? '请填写联系微信' : '请填写联系微信');
  if (wechat.length < 3) throw invalid('请填写联系微信');
  const phone = text(body.phone);
  if (phone && (phone.length > 30 || !PHONE.test(phone))) throw invalid('电话格式不正确');
  if (body.agreed !== true) throw invalid('请确认发布资料真实且有权公开联系方式');
  return { type, category, settlement, title, organization, region, scale, resources, requirements, description, budget, period, deadline, contactName, wechat, phone };
}

function demandColumns(input: ReturnType<typeof demandInput>, status: string, reason: string, history: string, version: number, userId: string) {
  const now = new Date();
  return {
    demand_type: input.type,
    title: input.title,
    organization: input.organization,
    category: input.category,
    region: input.region,
    scale_text: input.scale,
    resources: input.resources,
    requirements: input.requirements,
    description: input.description,
    budget: input.budget,
    settlement: input.settlement,
    period_text: input.period,
    deadline: input.deadline,
    contact_name: input.contactName,
    wechat: sm4Encrypt(input.wechat),
    phone: input.phone ? sm4Encrypt(input.phone) : null,
    status,
    reason,
    history_json: history,
    version,
    update_time: now,
    update_user: userId,
  };
}

export async function submitDemand(db: CampusDb, userId: string, body: Record<string, unknown>) {
  const id = text(body.id);
  if (id.length > 64) throw invalid('需求id不能超过64字');
  const input = demandInput(body);
  const now = new Date();
  if (!id) {
    const demandId = newId();
    const history = JSON.stringify([{ action: 'submit', reason: '首次提交审核', at: shanghaiDateTime(now) }]);
    await insertRow(db, 'sc_campus_demand', {
      ...stamp(userId),
      id: demandId,
      user_id: userId,
      submitted_time: now,
      ...demandColumns(input, 'pending', '', history, 1, userId),
    });
    return demandRecord(await reload(db, 'sc_campus_demand', demandId));
  }
  const version = body.version == null || body.version === '' ? null : intValue(body.version);
  if (version == null || version < 1) throw invalid('版本号不合法');
  const current = await queryOne(db, sql`SELECT * FROM sc_campus_demand WHERE id = ${id} AND user_id = ${userId} AND ${alive()} LIMIT 1`);
  if (!current) throw campus(121001, '需求不存在或不属于你');
  if (cellNumber(current, 'version') !== version) throw campus(121009, '需求已更新，请刷新记录后重新编辑');
  const history = parseHistory(current.history_json);
  history.push({ action: 'submit', reason: '修改后重新提交审核', at: shanghaiDateTime(now) });
  const columns = demandColumns(input, 'pending', '', JSON.stringify(history), version + 1, userId);
  const updated = await executeAffected(
    db,
    sql`UPDATE sc_campus_demand SET demand_type = ${columns.demand_type}, title = ${columns.title}, organization = ${columns.organization},
        category = ${columns.category}, region = ${columns.region}, scale_text = ${columns.scale_text}, resources = ${columns.resources},
        requirements = ${columns.requirements}, description = ${columns.description}, budget = ${columns.budget}, settlement = ${columns.settlement},
        period_text = ${columns.period_text}, deadline = ${columns.deadline}, contact_name = ${columns.contact_name}, wechat = ${columns.wechat},
        phone = ${columns.phone}, status = ${columns.status}, reason = ${columns.reason}, history_json = ${columns.history_json},
        version = ${columns.version}, update_time = ${columns.update_time}, update_user = ${columns.update_user}
        WHERE id = ${id} AND version = ${version} AND user_id = ${userId} AND ${alive()}`,
  );
  if (updated !== 1) throw campus(121009, '需求已更新，请刷新记录后重新编辑');
  return demandRecord(await reload(db, 'sc_campus_demand', id));
}

async function ownedDemand(db: CampusDb, userId: string, id: string) {
  if (!id) throw invalid('需求id不能为空');
  if (id.length > 64) throw invalid('需求id不能超过64字');
  const row = await queryOne(db, sql`SELECT * FROM sc_campus_demand WHERE id = ${id} AND user_id = ${userId} AND ${alive()} LIMIT 1`);
  if (!row) throw campus(121001, '需求不存在或不属于你');
  return row;
}

export async function withdrawDemand(db: CampusDb, userId: string, body: Record<string, unknown>) {
  const version = requiredVersion(body.version);
  const current = await ownedDemand(db, userId, text(body.id));
  if (cellNumber(current, 'version') !== version) throw campus(121009, '需求已更新，请刷新后重新核验');
  const status = cellText(current, 'status');
  if (status !== 'pending' && status !== 'published') throw campus(121009, '当前状态不可撤回');
  const history = parseHistory(current.history_json);
  history.push({ action: 'withdraw', reason: '发布者主动撤回', at: shanghaiDateTime() });
  const updated = await executeAffected(
    db,
    sql`UPDATE sc_campus_demand SET status = 'offline', reason = '发布者主动撤回', history_json = ${JSON.stringify(history)},
        version = ${version + 1}, update_time = ${new Date()}, update_user = ${userId}
        WHERE id = ${cellText(current, 'id')} AND version = ${version} AND ${alive()}`,
  );
  if (updated !== 1) throw campus(121009, '需求已更新，请刷新后重新核验');
  return demandRecord(await reload(db, 'sc_campus_demand', cellText(current, 'id') ?? ''));
}

export async function reviewDemand(db: CampusDb, operatorId: string, body: Record<string, unknown>) {
  const id = text(body.id);
  if (!id) throw invalid('需求id不能为空');
  if (id.length > 64) throw invalid('需求id不能超过64字');
  const version = requiredVersion(body.version);
  atMost(text(body.reason), 500, '处理原因不能超过500字');
  atMost(text(body.status), 32, '状态不合法');
  const status = text(body.status);
  const current = await queryOne(db, sql`SELECT * FROM sc_campus_demand WHERE id = ${id} AND ${alive()} LIMIT 1`);
  if (!current) throw campus(121001, '需求不存在或不属于你');
  if (cellNumber(current, 'version') !== version) throw campus(121009, '需求已更新，请刷新后重新核验');
  const currentStatus = cellText(current, 'status');
  const reviewable =
    (currentStatus === 'pending' && (status === 'published' || status === 'rejected')) ||
    (currentStatus === 'published' && status === 'offline');
  if (!reviewable) throw campus(121009, '当前状态不可执行此操作，请刷新');
  const reason = text(body.reason);
  if (status !== 'published' && reason.length < 2) throw invalid('请填写至少两个字的处理原因');
  if (status === 'published' && (cellText(current, 'deadline') ?? '') < shanghaiDay()) throw invalid('需求已截止，请驳回并要求发布者更新日期');
  const storedReason = status === 'published' ? '' : reason;
  const history = parseHistory(current.history_json);
  history.push({ action: status, reason: storedReason, at: shanghaiDateTime() });
  const updated = await executeAffected(
    db,
    sql`UPDATE sc_campus_demand SET status = ${status}, reason = ${storedReason}, history_json = ${JSON.stringify(history)},
        version = ${version + 1}, update_time = ${new Date()}, update_user = ${operatorId}
        WHERE id = ${id} AND version = ${version} AND ${alive()}`,
  );
  if (updated !== 1) throw campus(121009, '需求已更新，请刷新后重新核验');
  return demandRecord(await reload(db, 'sc_campus_demand', id));
}

function materialResult(row: Row, hideReason = false) {
  return {
    id: cellText(row, 'id'),
    title: cellText(row, 'title'),
    category: cellText(row, 'category'),
    description: cellText(row, 'description'),
    author: cellText(row, 'author'),
    official: flag(row.official),
    featured: flag(row.featured),
    filename: cellText(row, 'filename'),
    size: cellNumber(row, 'size'),
    extension: cellText(row, 'extension'),
    status: cellText(row, 'status'),
    reason: hideReason ? '' : blank(cellText(row, 'reason')),
    downloads: cellNumber(row, 'downloads'),
    createdAt: asDate(row.create_time),
  };
}

export async function publishedMaterials(db: CampusDb) {
  const rows = await queryRows(
    db,
    sql`SELECT * FROM sc_campus_material WHERE ${alive()} AND status = 'published' ORDER BY featured DESC, create_time DESC`,
  );
  return rows.map((row) => materialResult(row, true));
}

export async function myMaterials(db: CampusDb, userId: string) {
  const rows = await queryRows(
    db,
    sql`SELECT * FROM sc_campus_material WHERE ${alive()} AND user_id = ${userId} AND official = 0 ORDER BY create_time DESC`,
  );
  return rows.map((row) => materialResult(row));
}

export async function adminMaterialList(db: CampusDb) {
  const rows = await queryRows(db, sql`SELECT * FROM sc_campus_material WHERE ${alive()} ORDER BY create_time DESC`);
  return rows.map((row) => materialResult(row));
}

function materialFields(title: string, category: string, description: string, author: string) {
  if (
    !title ||
    title.length > 80 ||
    !MATERIAL_CATEGORIES.has(category) ||
    !description ||
    description.length > 1000 ||
    !author ||
    author.length > 40
  ) {
    throw invalid('请完整填写标题、分类、作者和介绍');
  }
}

function prepareMaterial(fields: Record<string, string>, file: UploadFile | undefined) {
  if (fields.agreed !== 'true') throw invalid('请确认拥有资料分享权利');
  const title = text(fields.title);
  const category = text(fields.category);
  const description = text(fields.description);
  const author = text(fields.author);
  materialFields(title, category, description, author);
  if (!file || file.buffer.length === 0 || !file.filename) throw invalid('请选择一个 PPT 文件');
  const extension = file.filename.includes('.') ? file.filename.slice(file.filename.lastIndexOf('.') + 1).toLowerCase() : '';
  if (extension !== 'ppt' && extension !== 'pptx') throw invalid('仅支持 .ppt 和 .pptx 文件');
  if (file.buffer.length > MATERIAL_LIMIT) throw campus(121011, '文件不能超过 20 MB');
  if (!isPresentation(file.buffer, extension)) throw invalid('文件内容不是有效的 PPT，请重新选择');
  const cleaned = file.filename.replace(/[\\/\r\n\u0000-\u001f]/g, '_');
  return {
    title,
    category,
    description,
    author,
    extension,
    bytes: file.buffer,
    filename: cleaned.length <= 200 ? cleaned : cleaned.slice(-200),
  };
}

async function insertMaterial(db: CampusDb, row: Record<string, unknown>, target: string) {
  try {
    await insertRow(db, 'sc_campus_material', row);
  } catch (error) {
    await rm(target, { force: true });
    throw error;
  }
}

export async function uploadMaterial(db: CampusDb, userId: string, fields: Record<string, string>, file: UploadFile | undefined) {
  const prepared = prepareMaterial(fields, file);
  const id = newId();
  const storageName = `${id}.${prepared.extension}`;
  const target = await writeNamedFile(storageDir('materials', 'CAMPUS_MATERIAL_DIR'), storageName, prepared.bytes);
  await insertMaterial(db, {
    ...stamp(userId),
    id,
    user_id: userId,
    title: prepared.title,
    category: prepared.category,
    description: prepared.description,
    author: prepared.author,
    official: 0,
    featured: 0,
    filename: prepared.filename,
    extension: prepared.extension,
    size: prepared.bytes.length,
    storage_name: storageName,
    status: 'pending',
    reason: '',
    downloads: 0,
    update_time: new Date(),
  }, target);
  return materialResult(await reload(db, 'sc_campus_material', id));
}

export async function uploadOfficialMaterial(db: CampusDb, operatorId: string, fields: Record<string, string>, file: UploadFile | undefined) {
  const prepared = prepareMaterial(fields, file);
  const id = newId();
  const storageName = `${id}.${prepared.extension}`;
  const target = await writeNamedFile(storageDir('materials', 'CAMPUS_MATERIAL_DIR'), storageName, prepared.bytes);
  const now = new Date();
  await insertMaterial(db, {
    ...stamp(operatorId),
    id,
    user_id: operatorId,
    title: prepared.title,
    category: prepared.category,
    description: prepared.description,
    author: prepared.author,
    official: 1,
    featured: fields.featured === 'true' ? 1 : 0,
    filename: prepared.filename,
    extension: prepared.extension,
    size: prepared.bytes.length,
    storage_name: storageName,
    status: 'published',
    reason: '',
    downloads: 0,
    create_user: operatorId,
    update_time: now,
    update_user: operatorId,
  }, target);
  return materialResult(await reload(db, 'sc_campus_material', id));
}

export async function reviewMaterial(db: CampusDb, body: Record<string, unknown>) {
  const status = text(body.status);
  if (status !== 'published' && status !== 'rejected' && status !== 'offline') throw invalid('状态不合法');
  const reason = text(body.reason);
  if (status !== 'published' && reason.length < 2) throw invalid('请填写至少两个字的审核或下架原因');
  const id = text(body.id);
  const current = await queryOne(db, sql`SELECT id FROM sc_campus_material WHERE id = ${id} AND ${alive()} LIMIT 1`);
  if (!current) throw campus(121001, '资料不存在');
  await sql`UPDATE sc_campus_material SET status = ${status}, reason = ${status === 'published' ? '' : reason.slice(0, 500)}, update_time = ${new Date()}
            WHERE id = ${id} AND ${alive()}`.execute(db);
  return materialResult(await reload(db, 'sc_campus_material', id));
}

export async function saveMaterial(db: CampusDb, operatorId: string, body: Record<string, unknown>) {
  const status = text(body.status);
  if (!['pending', 'published', 'rejected', 'offline'].includes(status)) throw invalid('状态不合法');
  const title = text(body.title);
  const category = text(body.category);
  const description = text(body.description);
  const author = text(body.author);
  const reason = text(body.reason);
  materialFields(title, category, description, author);
  if (status !== 'published' && status !== 'pending' && reason.length < 2) throw invalid('请填写至少两个字的审核或下架原因');
  const id = text(body.id);
  const current = await queryOne(db, sql`SELECT id FROM sc_campus_material WHERE id = ${id} AND ${alive()} LIMIT 1`);
  if (!current) throw campus(121001, '资料不存在');
  const storedReason = status === 'published' || status === 'pending' ? '' : reason.slice(0, 500);
  await sql`UPDATE sc_campus_material SET title = ${title}, category = ${category}, description = ${description}, author = ${author},
            featured = ${body.featured === true ? 1 : 0}, status = ${status}, reason = ${storedReason}, update_time = ${new Date()}, update_user = ${operatorId}
            WHERE id = ${id} AND ${alive()}`.execute(db);
  return materialResult(await reload(db, 'sc_campus_material', id));
}

export async function materialFile(db: CampusDb, id: string, userId: string | null, admin: boolean): Promise<StoredFile> {
  const row = await queryOne(db, sql`SELECT * FROM sc_campus_material WHERE id = ${id} AND ${alive()} LIMIT 1`);
  if (!row || !cellText(row, 'storage_name')) throw campus(121001, '资料不存在或已下架');
  const published = cellText(row, 'status') === 'published';
  if (!admin && !published && userId !== cellText(row, 'user_id')) throw campus(121001, '资料不存在或已下架');
  const extension = cellText(row, 'extension') ?? '';
  let bytes: Buffer;
  try {
    bytes = await readFile(containedPath(storageDir('materials', 'CAMPUS_MATERIAL_DIR'), cellText(row, 'storage_name') ?? ''));
  } catch {
    throw campus(121001, '文件不存在，请联系管理员');
  }
  if (!admin && published) {
    await sql`UPDATE sc_campus_material SET downloads = downloads + 1 WHERE id = ${id} AND ${alive()}`.execute(db);
  }
  const contentType =
    extension === 'pptx' ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' : 'application/vnd.ms-powerpoint';
  return { bytes, contentType, filename: cellText(row, 'filename') ?? `download.${extension}`, extension };
}

function caseResult(row: Row) {
  const created = asDate(row.create_time);
  const updated = asDate(row.update_time) ?? created;
  return {
    section: cellText(row, 'section') ?? 'case',
    id: cellText(row, 'id'),
    title: cellText(row, 'title'),
    category: blank(cellText(row, 'category')),
    summary: cellText(row, 'summary'),
    cover: blank(cellText(row, 'cover')),
    articleUrl: blank(cellText(row, 'article_url')),
    source: blank(cellText(row, 'source')),
    publishedAt: blank(cellText(row, 'published_at')),
    featured: flag(row.featured),
    status: cellText(row, 'status'),
    version: cellNumber(row, 'version') || 1,
    reason: blank(cellText(row, 'reason')),
    createdAt: created,
    updatedAt: updated,
  };
}

function providerPortfolio(row: Row) {
  return objectOf(row.portfolio_json);
}

function providerContact(row: Row) {
  const wechat = sm4Decrypt(row.public_wechat);
  if (!wechat) return undefined;
  const phone = sm4Decrypt(row.public_phone);
  return phone ? { wechat, phone } : { wechat };
}

function providerResult(row: Row) {
  const portfolio = providerPortfolio(row) ?? {};
  const contact = providerContact(row);
  return {
    section: 'company',
    id: cellText(row, 'id'),
    title: cellText(row, 'title'),
    category: '',
    summary: cellText(row, 'summary'),
    cover: blank(cellText(row, 'cover')),
    articleUrl: blank(cellText(row, 'article_url')),
    source: blank(cellText(row, 'source')),
    publishedAt: '',
    featured: false,
    status: cellText(row, 'status'),
    provider: portfolio,
    ...(contact ? { publicContact: contact } : {}),
    verifiedProfile: {
      id: cellText(row, 'profile_id'),
      name: blank(cellText(row, 'verified_name')),
      organization: blank(cellText(row, 'verified_org')),
    },
    version: cellNumber(row, 'version') || 1,
    reason: blank(cellText(row, 'reason')),
    createdAt: asDate(row.create_time),
  };
}

function providerShowcase(row: Row) {
  if (!cellText(row, 'portfolio_json')) return null;
  const source = providerResult(row);
  const published = asDate(row.update_time) ?? asDate(row.create_time);
  const day = published ? published.toISOString().slice(0, 10) : '';
  return {
    ...source,
    featured: flag(row.featured),
    publishedAt: day,
    updatedAt: published,
  };
}

async function providerShowcases(db: CampusDb, publishedOnly: boolean) {
  const rows = await queryRows(
    db,
    publishedOnly
      ? sql`SELECT * FROM sc_campus_provider WHERE ${alive()} AND status = 'published' ORDER BY update_time DESC`
      : sql`SELECT * FROM sc_campus_provider WHERE ${alive()} ORDER BY update_time DESC`,
  );
  return rows.flatMap((row) => {
    const item = providerShowcase(row);
    return item ? [item] : [];
  });
}

export async function publishedCases(db: CampusDb) {
  const rows = await queryRows(
    db,
    sql`SELECT * FROM sc_campus_case WHERE ${alive()} AND status = 'published' ORDER BY featured DESC, published_at DESC, create_time DESC`,
  );
  return [...rows.map(caseResult), ...(await providerShowcases(db, true))];
}

export async function adminCaseList(db: CampusDb) {
  const rows = await queryRows(db, sql`SELECT * FROM sc_campus_case WHERE ${alive()} ORDER BY update_time DESC, create_time DESC`);
  return [...rows.map(caseResult), ...(await providerShowcases(db, false))];
}

export async function saveCase(db: CampusDb, operatorId: string, body: Record<string, unknown>) {
  const id = text(body.id);
  if (id) {
    const provider = await queryOne(db, sql`SELECT * FROM sc_campus_provider WHERE id = ${id} AND ${alive()} LIMIT 1`);
    if (provider) return updateProviderFromCase(db, operatorId, provider, body);
  }
  const status = text(body.status);
  if (!CASE_STATUSES.has(status)) throw invalid('状态不合法');
  const title = text(body.title);
  const summary = text(body.summary);
  const source = text(body.source);
  const category = text(body.category);
  const articleUrl = text(body.articleUrl);
  const cover = text(body.cover);
  const publishedAt = text(body.publishedAt);
  const reason = text(body.reason);
  if (!title || title.length > 100 || !summary || summary.length > 600) throw invalid('请填写标题和简介');
  if (!source || source.length > 50) throw invalid('请填写公众号来源');
  if (category && !CASE_CATEGORIES.has(category)) throw invalid('案例分类不合法');
  if (!isCaseArticle(articleUrl)) throw invalid('请填写 https://mp.weixin.qq.com/s 开头的公众号原文链接');
  if (cover && (!cover.startsWith('https://') || cover.length > 2000)) throw invalid('封面请使用 HTTPS 图片链接');
  if (publishedAt && !/^\d{4}-\d{2}-\d{2}$/.test(publishedAt)) throw invalid('文章日期格式不正确');
  if (status === 'offline' && reason.length < 2) throw invalid('请填写下线原因');
  const current = id ? await queryOne(db, sql`SELECT * FROM sc_campus_case WHERE id = ${id} AND ${alive()} LIMIT 1`) : undefined;
  if (id && !current) throw campus(121001, '案例不存在');
  if (current && cellNumber(current, 'version') !== intValue(body.version)) throw campus(121009, '内容已更新，请刷新后重新保存');
  const storedReason = status === 'offline' ? reason.slice(0, 500) : '';
  const featured = body.featured === true ? 1 : 0;
  if (!current) {
    const caseId = newId();
    const now = new Date();
    await insertRow(db, 'sc_campus_case', {
      ...stamp(operatorId),
      id: caseId,
      section: 'case',
      title,
      category,
      summary,
      cover,
      article_url: articleUrl,
      source,
      published_at: publishedAt,
      featured,
      status,
      reason: storedReason,
      version: 1,
      update_time: now,
      update_user: operatorId,
    });
    return caseResult(await reload(db, 'sc_campus_case', caseId));
  }
  const nextVersion = cellNumber(current, 'version') + 1;
  await sql`UPDATE sc_campus_case SET section = 'case', title = ${title}, category = ${category}, summary = ${summary}, cover = ${cover},
            article_url = ${articleUrl}, source = ${source}, published_at = ${publishedAt}, featured = ${featured}, status = ${status},
            reason = ${storedReason}, version = ${nextVersion}, update_time = ${new Date()}, update_user = ${operatorId}
            WHERE id = ${id} AND version = ${cellNumber(current, 'version')} AND ${alive()}`.execute(db);
  return caseResult(await reload(db, 'sc_campus_case', id));
}

async function updateProviderFromCase(db: CampusDb, operatorId: string, row: Row, body: Record<string, unknown>) {
  const version = intValue(body.version);
  if (version == null || version !== cellNumber(row, 'version')) throw campus(121009, '资料已更新，请刷新后重新核对');
  const status = text(body.status) || cellText(row, 'status') || '';
  if (!['pending', 'published', 'rejected', 'offline'].includes(status)) throw invalid('状态不合法');
  const reason = text(body.reason);
  if ((status === 'rejected' || status === 'offline') && reason.length < 2) throw invalid('请填写审核原因');
  const title = text(body.title);
  const summary = text(body.summary);
  if (!title || title.length > 100) throw invalid('请填写标题，最多 100 字');
  if (!summary || summary.length > 600) throw invalid('请填写简介，最多 600 字');
  const cover = text(body.cover) || cellText(row, 'cover') || '';
  const storedReason = status === 'published' || status === 'pending' ? '' : reason.slice(0, 500);
  await sql`UPDATE sc_campus_provider SET title = ${title}, summary = ${summary}, cover = ${cover.slice(0, 500)},
            article_url = ${text(body.articleUrl)}, featured = ${body.featured === true ? 1 : 0}, status = ${status}, reason = ${storedReason},
            version = ${version + 1}, update_time = ${new Date()}, update_user = ${operatorId}
            WHERE id = ${cellText(row, 'id')} AND version = ${version} AND ${alive()}`.execute(db);
  const saved = await reload(db, 'sc_campus_provider', cellText(row, 'id') ?? '');
  const shown = providerShowcase(saved);
  if (!shown) throw campus(121001, '服务商资料不存在');
  return shown;
}

async function readyProfile(db: CampusDb, userId: string) {
  const profile = await myProfile(db, userId);
  const verification = await identityVerification(db, userId);
  const ready = Boolean(
    profile &&
      profile.status === APPROVED &&
      !profile.hidden &&
      verification &&
      verification.status === APPROVED &&
      profile.id === verification.profileId &&
      profile.roleType === verification.identityType &&
      (profile.orgName ?? '').trim() === (verification.orgName ?? '').trim(),
  );
  if (!ready || !profile) throw campus(121002, '请先完成入驻与认证，通过后再提交服务商资料');
  return profile;
}

function portfolioImages(portfolio: Record<string, unknown>) {
  const images = stringArray(portfolio.images);
  const projects = Array.isArray(portfolio.projects) ? portfolio.projects : [];
  for (const project of projects) {
    const record = objectOf(project);
    if (record) images.push(...stringArray(record.images));
  }
  return images;
}

function submissionKey(title: string, summary: string, portfolio: Record<string, unknown>) {
  const copy = { ...portfolio };
  if (Array.isArray(copy.services)) copy.services = stringArray(copy.services).sort();
  return `${title.trim()}\n${summary.trim()}\n${stableJson(copy)}`;
}

async function ownsProviderImage(db: CampusDb, userId: string, url: string) {
  if (!url.startsWith(PROVIDER_IMAGE_PREFIX)) return false;
  const id = url.slice(PROVIDER_IMAGE_PREFIX.length);
  if (!IMAGE_ID.test(id)) return false;
  const image = await queryOne(db, sql`SELECT user_id FROM sc_campus_provider_image WHERE id = ${id} AND ${alive()} LIMIT 1`);
  return cellText(image, 'user_id') === userId;
}

async function validatePortfolio(db: CampusDb, userId: string, portfolio: Record<string, unknown>) {
  const services = Array.isArray(portfolio.services) ? portfolio.services.map(String) : [];
  if (services.length === 0 || services.length > 8 || services.some((service) => !PROVIDER_SERVICES.includes(service))) {
    throw invalid('请选择可提供的服务');
  }
  const region = text(portfolio.region);
  if (!region || region.length > 120) throw invalid('请填写服务覆盖地区，最多 120 字');
  if (text(portfolio.team).length > 200 || text(portfolio.experience).length > 400 || text(portfolio.clients).length > 200) {
    throw invalid('团队、经验或合作客户介绍超过字数限制');
  }
  const projects = Array.isArray(portfolio.projects) ? portfolio.projects : [];
  if (projects.length === 0 || projects.length > 6) throw invalid('请提供 1–6 个代表案例');
  const images = portfolioImages(portfolio);
  const gallery = Array.isArray(portfolio.images) ? portfolio.images : null;
  if ((gallery && gallery.length > 12) || images.length > 24) throw invalid('实力展示最多 12 张图片，全部资料合计最多 24 张');
  for (let index = 0; index < projects.length; index += 1) {
    const project = objectOf(projects[index]);
    if (!project) throw invalid(`案例 ${index + 1} 需填写案例名称，成果说明最多 600 字`);
    const title = text(project.title);
    if (!title || title.length > 80 || text(project.summary).length > 600) throw invalid(`案例 ${index + 1} 需填写案例名称，成果说明最多 600 字`);
    const url = text(project.url);
    const pictures = Array.isArray(project.images) ? project.images : null;
    if (url && !isWechatArticle(url)) throw invalid(`案例 ${index + 1} 请使用有效的微信公众号文章链接`);
    if (!url && (!pictures || pictures.length === 0)) throw invalid(`案例 ${index + 1} 至少提供公众号链接或案例图片`);
    if (pictures && pictures.length > 4) throw invalid(`案例 ${index + 1} 最多上传 4 张图片`);
  }
  for (const image of images) {
    if (!new RegExp(`^${PROVIDER_IMAGE_PREFIX}[0-9a-f-]{36}$`).test(image) || !(await ownsProviderImage(db, userId, image))) {
      throw invalid('请使用本人上传的服务商资料图片');
    }
  }
}

function firstArticle(portfolio: Record<string, unknown>) {
  const projects = Array.isArray(portfolio.projects) ? portfolio.projects : [];
  for (const project of projects) {
    const url = text(objectOf(project)?.url);
    if (url) return url;
  }
  return '';
}

async function providerByUser(db: CampusDb, userId: string) {
  return queryOne(db, sql`SELECT * FROM sc_campus_provider WHERE ${alive()} AND user_id = ${userId} ORDER BY update_time DESC LIMIT 1`);
}

export async function myProvider(db: CampusDb, userId: string) {
  const row = await providerByUser(db, userId);
  return row ? providerResult(row) : null;
}

export async function adminProviderList(db: CampusDb) {
  const rows = await queryRows(db, sql`SELECT * FROM sc_campus_provider WHERE ${alive()} ORDER BY update_time DESC`);
  return rows.map(providerResult);
}

export async function submitProvider(db: CampusDb, userId: string, body: Record<string, unknown>) {
  const profile = await readyProfile(db, userId);
  const title = between(text(body.title), 2, 100, '展示名称需为 2–100 字');
  const summary = between(text(body.summary), 10, 600, '服务简介需为 10–600 字');
  const portfolio = objectOf(body.provider);
  if (!portfolio) throw invalid('请填写服务商资料');
  if (body.agreed !== true) throw invalid('请确认资料真实并同意公开联系方式');
  await validatePortfolio(db, userId, portfolio);
  const id = text(body.id);
  let current: Row | undefined;
  if (id) {
    current = await queryOne(db, sql`SELECT * FROM sc_campus_provider WHERE id = ${id} AND user_id = ${userId} AND ${alive()} LIMIT 1`);
    if (!current) throw campus(121001, '申请不存在或不属于你');
    if (intValue(body.version) !== cellNumber(current, 'version')) throw campus(121009, '资料已更新，请刷新后重新编辑');
  }
  const previous = current ?? (await providerByUser(db, userId));
  const key = submissionKey(title, summary, portfolio);
  if (previous && (cellText(previous, 'status') === 'pending' || cellText(previous, 'status') === 'published')) {
    const previousPortfolio = objectOf(previous.portfolio_json) ?? {};
    if (key === submissionKey(cellText(previous, 'title') ?? '', cellText(previous, 'summary') ?? '', previousPortfolio)) return providerResult(previous);
  }
  if (!current && previous) throw campus(121009, '你已有服务商资料，请编辑原申请');
  if (previous && cellText(previous, 'status') === 'rejected') {
    const previousPortfolio = objectOf(previous.portfolio_json) ?? {};
    if (key === submissionKey(cellText(previous, 'title') ?? '', cellText(previous, 'summary') ?? '', previousPortfolio)) {
      throw campus(121009, '请根据反馈补充资料后再提交，无需重复认证');
    }
  }
  const images = portfolioImages(portfolio);
  const sourceText = (profile.orgName || profile.name || '').slice(0, 50);
  const now = new Date();
  const values = {
    profile_id: profile.id,
    title,
    summary,
    portfolio_json: JSON.stringify(portfolio),
    cover: images[0] ?? '',
    article_url: firstArticle(portfolio),
    source: sourceText,
    status: 'pending',
    reason: '',
    public_wechat: profile.wechat ? sm4Encrypt(profile.wechat) : null,
    public_phone: profile.phone ? sm4Encrypt(profile.phone) : null,
    verified_name: (profile.name ?? '').slice(0, 80),
    verified_org: (profile.orgName ?? '').slice(0, 80),
    update_time: now,
    update_user: userId,
  };
  const providerId = current ? cellText(current, 'id') ?? '' : randomUUID();
  if (!current) {
    await insertRow(db, 'sc_campus_provider', {
      ...stamp(userId),
      ...values,
      id: providerId,
      user_id: userId,
      version: 1,
      featured: 0,
    });
  } else {
    await sql`UPDATE sc_campus_provider SET profile_id = ${values.profile_id}, title = ${values.title}, summary = ${values.summary},
              portfolio_json = ${values.portfolio_json}, cover = ${values.cover}, article_url = ${values.article_url}, source = ${values.source},
              status = ${values.status}, reason = ${values.reason}, public_wechat = ${values.public_wechat}, public_phone = ${values.public_phone},
              verified_name = ${values.verified_name}, verified_org = ${values.verified_org}, version = ${cellNumber(current, 'version') + 1},
              update_time = ${now}, update_user = ${userId}
              WHERE id = ${providerId} AND ${alive()}`.execute(db);
  }
  return providerResult(await reload(db, 'sc_campus_provider', providerId));
}

export async function uploadProviderImage(db: CampusDb, userId: string, file: UploadFile | undefined) {
  await readyProfile(db, userId);
  const contentType = requireImage(file);
  const id = randomUUID();
  const target = await writeNamedFile(storageDir('provider-images', 'CAMPUS_PROVIDER_DIR'), id, file?.buffer ?? Buffer.alloc(0));
  const now = new Date();
  try {
    await insertRow(db, 'sc_campus_provider_image', {
      ...stamp(userId),
      id,
      user_id: userId,
      content_type: contentType,
      update_time: now,
      update_user: userId,
    });
  } catch (error) {
    await rm(target, { force: true });
    throw error;
  }
  return { id, url: `${PROVIDER_IMAGE_PREFIX}${id}` };
}

async function providerImageVisible(db: CampusDb, url: string) {
  const count = await queryCount(
    db,
    sql`SELECT COUNT(*) AS total FROM sc_campus_provider WHERE ${alive()} AND status = 'published' AND (cover = ${url} OR portfolio_json LIKE ${`%${url}%`})`,
  );
  return count > 0;
}

export async function providerImageFile(db: CampusDb, id: string, userId: string | null, admin: boolean): Promise<StoredFile> {
  if (!IMAGE_ID.test(id)) throw campus(121001, '图片不存在或尚未公开');
  const image = await queryOne(db, sql`SELECT * FROM sc_campus_provider_image WHERE id = ${id} AND ${alive()} LIMIT 1`);
  if (!image) throw campus(121001, '图片不存在或尚未公开');
  const owner = userId != null && userId === cellText(image, 'user_id');
  if (!owner && !admin && !(await providerImageVisible(db, `${PROVIDER_IMAGE_PREFIX}${id}`))) {
    throw campus(121001, '图片尚未公开');
  }
  return { bytes: await readNamedFile(storageDir('provider-images', 'CAMPUS_PROVIDER_DIR'), id), contentType: cellText(image, 'content_type') ?? 'application/octet-stream' };
}

export async function reviewProvider(db: CampusDb, operatorId: string, body: Record<string, unknown>) {
  const id = text(body.id);
  const version = intValue(body.version);
  if (!id || version == null) throw invalid('服务商资料不存在');
  const row = await queryOne(db, sql`SELECT * FROM sc_campus_provider WHERE id = ${id} AND ${alive()} LIMIT 1`);
  if (!row) throw campus(121001, '服务商资料不存在');
  if (version !== cellNumber(row, 'version')) throw campus(121009, '资料已更新，请刷新后重新核对');
  const status = text(body.status);
  const allowed = (cellText(row, 'status') === 'pending' && (status === 'published' || status === 'rejected')) || (cellText(row, 'status') === 'published' && status === 'offline');
  if (!allowed) throw campus(121009, '状态已变化，请刷新');
  const reason = text(body.reason);
  if (status !== 'published' && reason.length < 2) throw invalid('请填写审核原因');
  await sql`UPDATE sc_campus_provider SET status = ${status}, reason = ${status === 'published' ? '' : reason.slice(0, 500)},
            version = ${version + 1}, update_time = ${new Date()}, update_user = ${operatorId}
            WHERE id = ${id} AND version = ${version} AND ${alive()}`.execute(db);
  return providerResult(await reload(db, 'sc_campus_provider', id));
}

function mediaSchool(row: Row) {
  return {
    id: longId(row.id),
    catalogId: cellText(row, 'catalog_id'),
    name: cellText(row, 'name'),
    province: cellText(row, 'province'),
    city: cellText(row, 'city'),
    level: cellText(row, 'level'),
    kind: cellText(row, 'kind'),
    location: blank(cellText(row, 'location')),
    spec: blank(cellText(row, 'spec')),
    unit: blank(cellText(row, 'unit')),
  };
}

function mediaRecord(row: Row, userId: string | null, revealProof: boolean) {
  const mine = Boolean(userId) && userId === cellText(row, 'user_id');
  const details = objectOf(row.details_json) ?? {};
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(details)) normalized[key] = blank(value);
  return {
    id: cellText(row, 'id'),
    version: cellNumber(row, 'version') || 1,
    school: longId(row.resource_id),
    name: blank(cellText(row, 'contact_name')),
    org: blank(cellText(row, 'org_name')),
    price: row.price == null ? null : cellNumber(row, 'price'),
    phone: blank(sm4Decrypt(row.phone)),
    wechat: blank(sm4Decrypt(row.wechat)),
    description: blank(cellText(row, 'description')),
    proof: revealProof || mine ? blank(cellText(row, 'proof')) : '',
    campus: blank(cellText(row, 'campus')),
    location: blank(cellText(row, 'location')),
    spec: blank(cellText(row, 'spec')),
    images: stringArray(parseJson(row.images_json)),
    details: normalized,
    status: cellText(row, 'status'),
    date: blank(cellText(row, 'claim_date')),
    reason: blank(cellText(row, 'reason')),
    mine,
  };
}

export async function advertisingRecords(db: CampusDb, userId: string | null, admin: boolean) {
  const rows = await queryRows(
    db,
    admin
      ? sql`SELECT * FROM sc_campus_media_claim WHERE ${alive()} ORDER BY create_time DESC`
      : userId
        ? sql`SELECT * FROM sc_campus_media_claim WHERE ${alive()} AND (status = 'approved' OR user_id = ${userId}) ORDER BY create_time DESC`
        : sql`SELECT * FROM sc_campus_media_claim WHERE ${alive()} AND status = 'approved' ORDER BY create_time DESC`,
  );
  const ids: number[] = [];
  for (const row of rows) {
    const id = longId(row.resource_id);
    if (id != null && !ids.includes(id)) ids.push(id);
  }
  const resources = ids.length
    ? await queryRows(db, sql`SELECT * FROM sc_campus_media_resource WHERE ${alive()} AND id IN (${sql.join(ids.map((id) => sql`${id}`))})`)
    : [];
  const byId = new Map(resources.map((row) => [longId(row.id), row]));
  return {
    schools: ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [mediaSchool(row)] : [];
    }),
    records: rows.map((row) => mediaRecord(row, admin ? null : userId, admin)),
  };
}

function limitText(value: unknown, max: number) {
  const content = text(value);
  if (content.length > max) throw invalid('内容超出字数限制');
  return content;
}

function requiredText(value: unknown, min: number, max: number, message: string) {
  const content = text(value);
  if (content.length < min || content.length > max) throw invalid(message);
  return content;
}

function nfkc(value: unknown) {
  return text(value).normalize('NFKC');
}

function importKey(schoolId: unknown, kind: unknown, campusName: unknown, location: unknown, spec: unknown, org: unknown) {
  return JSON.stringify([nfkc(schoolId), nfkc(kind), nfkc(campusName), nfkc(location), nfkc(spec), nfkc(org)]);
}

async function ownedImportKeys(db: CampusDb, userId: string) {
  const claims = await queryRows(db, sql`SELECT * FROM sc_campus_media_claim WHERE ${alive()} AND user_id = ${userId}`);
  const ids = [...new Set(claims.map((row) => longId(row.resource_id)).filter((id): id is number => id != null))];
  const resources = ids.length
    ? await queryRows(db, sql`SELECT * FROM sc_campus_media_resource WHERE ${alive()} AND id IN (${sql.join(ids.map((id) => sql`${id}`))})`)
    : [];
  const byId = new Map(resources.map((row) => [longId(row.id), row]));
  const keys: string[] = [];
  for (const claim of claims) {
    const resource = byId.get(longId(claim.resource_id));
    if (!resource) continue;
    keys.push(
      importKey(
        cellText(resource, 'catalog_id'),
        cellText(resource, 'kind'),
        cellText(claim, 'campus'),
        cellText(claim, 'location') || cellText(resource, 'location'),
        cellText(claim, 'spec') || cellText(resource, 'spec'),
        cellText(claim, 'org_name'),
      ),
    );
  }
  return keys;
}

async function findOrCreateResource(db: CampusDb, item: Record<string, unknown>, userId: string) {
  const schoolId = requiredText(item.schoolId, 1, 32, '学校不在名录中');
  const kind = requiredText(item.kind, 1, 32, '媒体类型不正确');
  const found = await queryOne(
    db,
    sql`SELECT * FROM sc_campus_media_resource WHERE ${alive()} AND catalog_id = ${schoolId} AND kind = ${kind} ORDER BY id ASC LIMIT 1`,
  );
  if (found) return found;
  const now = new Date();
  await insertRow(db, 'sc_campus_media_resource', {
    delete_flag: 'NOT_DELETE',
    create_time: now,
    create_user: userId,
    update_time: now,
    update_user: userId,
    catalog_id: schoolId,
    name: requiredText(item.schoolName, 1, 128, '学校名称不在名录中'),
    province: limitText(item.province, 32),
    city: limitText(item.city, 32),
    level: limitText(item.level, 32),
    kind,
    location: requiredText(item.location, 1, 100, '请填写资源点位'),
    spec: requiredText(item.spec, 1, 100, '请填写资源规格'),
    unit: limitText(item.unit, 16) || '周',
  });
  const created = await queryOne(
    db,
    sql`SELECT * FROM sc_campus_media_resource WHERE ${alive()} AND catalog_id = ${schoolId} AND kind = ${kind} ORDER BY id DESC LIMIT 1`,
  );
  if (!created) throw invalid('学校或资源不存在');
  return created;
}

async function claimResource(db: CampusDb, body: Record<string, unknown>, current: Row | undefined, userId: string) {
  if (text(body.schoolId)) {
    if (!text(body.kind) || !text(body.campus) || !text(body.location) || !text(body.spec)) throw invalid('请选择学校，并填写校区、点位和规格');
    return findOrCreateResource(db, body, userId);
  }
  const schoolId = longId(body.school) ?? (current ? longId(current.resource_id) : null);
  const resource = schoolId == null ? undefined : await queryOne(db, sql`SELECT * FROM sc_campus_media_resource WHERE id = ${schoolId} AND ${alive()} LIMIT 1`);
  if (!resource) throw invalid('学校或资源不存在');
  return resource;
}

async function claimImages(db: CampusDb, value: unknown, userId: string) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw campus(403, '请上传你自己的点位图片');
  if (value.length > 6) throw invalid('最多上传 6 张图片');
  const images: string[] = [];
  for (const item of value) {
    const url = String(item ?? '');
    if (!url.startsWith(MEDIA_IMAGE_PREFIX)) throw campus(403, '请上传你自己的点位图片');
    const id = url.slice(MEDIA_IMAGE_PREFIX.length);
    const image = IMAGE_ID.test(id) ? await queryOne(db, sql`SELECT user_id FROM sc_campus_media_image WHERE id = ${id} AND ${alive()} LIMIT 1`) : undefined;
    if (!image || cellText(image, 'user_id') !== userId) throw campus(403, '请上传你自己的点位图片');
    images.push(url);
  }
  return images;
}

function claimDetails(value: unknown) {
  if (value == null) return {};
  const source = objectOf(value);
  if (!source) throw invalid('类目补充信息格式不正确');
  const entries = Object.entries(source);
  if (entries.length > 20) throw invalid('类目补充信息过多');
  const details: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (key.length > 40 || typeof item !== 'string') throw invalid('类目补充信息格式不正确');
    const content = item.trim();
    if (content.length > 180) throw invalid('补充信息最多填写 180 字');
    if (content) details[key] = content;
  }
  return details;
}

export async function uploadAdvertisingImage(db: CampusDb, userId: string, file: UploadFile | undefined) {
  const contentType = requireImage(file);
  const id = randomUUID();
  const target = await writeNamedFile(storageDir('advertising', 'CAMPUS_ADVERTISING_DIR'), id, file?.buffer ?? Buffer.alloc(0));
  const now = new Date();
  try {
    await insertRow(db, 'sc_campus_media_image', {
      ...stamp(userId),
      id,
      user_id: userId,
      content_type: contentType,
      update_time: now,
      update_user: userId,
    });
  } catch (error) {
    await rm(target, { force: true });
    throw error;
  }
  return { id, url: `${MEDIA_IMAGE_PREFIX}${id}` };
}

async function advertisingImageVisible(db: CampusDb, url: string) {
  const count = await queryCount(
    db,
    sql`SELECT COUNT(*) AS total FROM sc_campus_media_claim WHERE ${alive()} AND status = 'approved' AND images_json LIKE ${`%${url}%`}`,
  );
  return count > 0;
}

export async function advertisingImageFile(db: CampusDb, id: string, userId: string | null, admin: boolean): Promise<StoredFile> {
  if (!IMAGE_ID.test(id)) throw campus(121001, '图片不存在或尚未公开');
  const image = await queryOne(db, sql`SELECT * FROM sc_campus_media_image WHERE id = ${id} AND ${alive()} LIMIT 1`);
  if (!image) throw campus(121001, '图片不存在或尚未公开');
  const owner = userId != null && userId === cellText(image, 'user_id');
  if (!owner && !admin && !(await advertisingImageVisible(db, `${MEDIA_IMAGE_PREFIX}${id}`))) {
    throw campus(121001, '图片不存在或尚未公开');
  }
  return { bytes: await readNamedFile(storageDir('advertising', 'CAMPUS_ADVERTISING_DIR'), id), contentType: cellText(image, 'content_type') ?? 'application/octet-stream' };
}

export async function advertisingImportKeys(db: CampusDb, userId: string) {
  return ownedImportKeys(db, userId);
}

export async function submitAdvertisingClaim(db: CampusDb, userId: string, body: Record<string, unknown>) {
  if (body.agreed !== true) throw invalid('请确认你有权发布资源并同意公开联系方式');
  const id = text(body.id);
  let current: Row | undefined;
  if (id) {
    current = await queryOne(db, sql`SELECT * FROM sc_campus_media_claim WHERE id = ${id} AND ${alive()} LIMIT 1`);
    if (!current || cellText(current, 'user_id') !== userId) throw campus(403, '无权编辑该认领');
    if (intValue(body.version) !== cellNumber(current, 'version')) throw campus(121009, '资料已更新，请刷新后重新编辑');
  }
  const org = requiredText(body.org, 1, 40, '请填写团队或主体名称');
  const name = requiredText(body.name, 1, 20, '请填写联系人');
  const phone = requiredText(body.phone, 11, 11, '联系电话需为 11 位中国大陆手机号');
  if (!MOBILE.test(phone)) throw invalid('联系电话需为 11 位中国大陆手机号');
  const description = requiredText(body.description, 1, 1000, '请填写资源介绍');
  const proof = requiredText(body.proof, 1, 500, '请填写归属证明');
  const campusName = limitText(body.campus, 80);
  const wechat = limitText(body.wechat, 40);
  const price = assertQuote(body.price);
  const images = await claimImages(db, body.images, userId);
  const details = claimDetails(body.details);
  const resource = await claimResource(db, body, current, userId);
  const location = limitText(body.location, 100) || cellText(resource, 'location') || '';
  const spec = limitText(body.spec, 100) || cellText(resource, 'spec') || '';
  const now = new Date();
  const claimId = current ? cellText(current, 'id') ?? '' : randomUUID();
  const values = {
    resource_id: longId(resource.id),
    contact_name: name,
    org_name: org,
    price,
    phone: sm4Encrypt(phone),
    wechat: wechat ? sm4Encrypt(wechat) : null,
    description,
    proof,
    campus: campusName,
    location,
    spec,
    images_json: JSON.stringify(images),
    details_json: Object.keys(details).length ? JSON.stringify(details) : null,
    status: 'pending',
    claim_date: shanghaiDay(now),
    reason: '',
    update_time: now,
    update_user: userId,
  };
  if (!current) {
    await insertRow(db, 'sc_campus_media_claim', { ...stamp(userId), ...values, id: claimId, user_id: userId, version: 1 });
  } else {
    await sql`UPDATE sc_campus_media_claim SET resource_id = ${values.resource_id}, contact_name = ${values.contact_name}, org_name = ${values.org_name},
              price = ${values.price}, phone = ${values.phone}, wechat = ${values.wechat}, description = ${values.description}, proof = ${values.proof},
              campus = ${values.campus}, location = ${values.location}, spec = ${values.spec}, images_json = ${values.images_json}, details_json = ${values.details_json},
              status = ${values.status}, claim_date = ${values.claim_date}, reason = ${values.reason}, version = ${cellNumber(current, 'version') + 1},
              update_time = ${now}, update_user = ${userId}
              WHERE id = ${claimId} AND ${alive()}`.execute(db);
  }
  return { ok: true };
}

export async function commitAdvertisingImport(db: CampusDb, userId: string, body: Record<string, unknown>) {
  if (body.agreed !== true) throw invalid('请确认你有权发布资源并同意公开联系方式');
  const claims = Array.isArray(body.claims) ? body.claims : [];
  if (claims.length === 0 || claims.length > 200) throw invalid('请先上传并通过校验，每次最多导入 200 条');
  const existing = new Set(await ownedImportKeys(db, userId));
  const seen = new Set<string>();
  const items = claims.map((item) => (objectOf(item) ?? {}) as Record<string, unknown>);
  for (const item of items) {
    const key = importKey(item.schoolId, item.kind, item.campus, item.location, item.spec, item.org);
    if (seen.has(key) || existing.has(key)) throw campus(121009, '部分点位已有认领，本次未提交。请检查“我的认领”并重新校验文件');
    seen.add(key);
  }
  const now = new Date();
  const today = shanghaiDay(now);
  await db.transaction().execute(async (trx) => {
    for (const item of items) {
      const resource = await findOrCreateResource(trx, {
        schoolId: item.schoolId,
        schoolName: item.schoolName,
        province: item.province,
        city: item.city,
        level: item.level,
        kind: item.kind,
        location: item.location,
        spec: item.spec,
        unit: item.unit,
      }, userId);
      const phone = requiredText(item.phone, 11, 11, '联系电话需为 11 位中国大陆手机号');
      if (!MOBILE.test(phone)) throw invalid('联系电话需为 11 位中国大陆手机号');
      const wechat = limitText(item.wechat, 40);
      await insertRow(trx, 'sc_campus_media_claim', {
        ...stamp(userId),
        id: randomUUID(),
        user_id: userId,
        resource_id: longId(resource.id),
        contact_name: requiredText(item.name, 1, 20, '联系人不能超过 20 字'),
        org_name: requiredText(item.org, 1, 40, '团队名称不能超过 40 字'),
        price: assertQuote(item.price),
        phone: sm4Encrypt(phone),
        wechat: wechat ? sm4Encrypt(wechat) : null,
        description: requiredText(item.description, 1, 1000, '报价说明不能超过 1000 字'),
        proof: requiredText(item.proof, 1, 500, '归属证明不能超过 500 字'),
        campus: requiredText(item.campus, 1, 80, '校区名称不能超过 80 字'),
        location: requiredText(item.location, 1, 100, '资源点位不能超过 100 字'),
        spec: requiredText(item.spec, 1, 100, '资源规格不能超过 100 字'),
        images_json: '[]',
        status: 'pending',
        claim_date: today,
        reason: '',
        version: 1,
        update_time: now,
        update_user: userId,
      });
    }
  });
  return { count: items.length, batchId: text(body.batchId) };
}

export async function reviewAdvertisingClaim(db: CampusDb, operatorId: string, body: Record<string, unknown>) {
  const id = text(body.id);
  const version = intValue(body.version);
  if (!id || version == null) throw invalid('认领不存在');
  const row = await queryOne(db, sql`SELECT * FROM sc_campus_media_claim WHERE id = ${id} AND ${alive()} LIMIT 1`);
  if (!row) throw campus(121001, '认领不存在');
  if (version !== cellNumber(row, 'version')) throw campus(121009, '资料已更新，请刷新后重新核对图片与报价');
  const status = text(body.status);
  const allowed = (cellText(row, 'status') === 'pending' && (status === 'approved' || status === 'rejected')) || (cellText(row, 'status') === 'approved' && status === 'offline');
  if (!allowed) throw campus(121009, '状态已变化，请刷新');
  const reason = text(body.reason);
  if (status !== 'approved' && reason.length < 2) throw invalid('请填写审核原因');
  await sql`UPDATE sc_campus_media_claim SET status = ${status}, reason = ${status === 'approved' ? '' : reason.slice(0, 1000)},
            version = ${version + 1}, update_time = ${new Date()}, update_user = ${operatorId}
            WHERE id = ${id} AND version = ${version} AND ${alive()}`.execute(db);
  return null;
}

export function fileMime(suffix: string, name: string) {
  const extension = (suffix || name.split('.').pop() || '').replace(/^\./, '').toLowerCase();
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'gif') return 'image/gif';
  if (extension === 'pdf') return 'application/pdf';
  return 'application/octet-stream';
}

export async function devFileTarget(db: CampusDb, id: string) {
  if (!id) throw campus(500, 'id不能为空');
  const row = await queryOne(db, sql`SELECT STORAGE_PATH, NAME, SUFFIX FROM dev_file WHERE ID = ${id} AND DELETE_FLAG = 'NOT_DELETE' LIMIT 1`);
  if (!row) throw campus(500, `文件不存在，id值为：${id}`);
  const storagePath = cellText(row, 'STORAGE_PATH') ?? cellText(row, 'storage_path') ?? '';
  const name = cellText(row, 'NAME') ?? cellText(row, 'name') ?? 'download';
  const suffix = cellText(row, 'SUFFIX') ?? cellText(row, 'suffix') ?? '';
  if (!storagePath) throw campus(500, `文件不存在，id值为：${id}`);
  if (/^https?:\/\//i.test(storagePath)) return { kind: 'http' as const, url: storagePath, mime: fileMime(suffix, name) };
  const path = isAbsolute(storagePath) ? storagePath : resolve(storagePath);
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error('not a file');
  } catch {
    throw campus(500, `图片读取或传输失败，id值为：${id}`);
  }
  return { kind: 'file' as const, path, mime: fileMime(suffix, name) };
}
