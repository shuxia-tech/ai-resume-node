import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import smCrypto from 'sm-crypto';
import { authRedis } from '@/auth/request-user.js';
import { fail } from '@/common/http-response.js';
import type { AppEnv } from '@/config/env.js';
import type { Database } from '@/infrastructure/database.js';
import { nextAdminId } from '@/modules/admin/admin-crud.js';

export type CampusDb = Kysely<Database>;
export type Row = Record<string, unknown>;

export class CampusError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export const campus = (code: number, message: string) => new CampusError(code, message);

export const PENDING = 'PENDING';
export const APPROVED = 'APPROVED';
export const REJECTED = 'REJECTED';
export const AMBASSADOR = 'AMBASSADOR';
export const CLUB = 'CLUB';
export const BRAND = 'BRAND';
export const SPONSOR = 'SPONSOR';
export const AMBASSADOR_RECRUIT = 'AMBASSADOR_RECRUIT';
export const PROFILE = 'PROFILE';
export const PROJECT = 'PROJECT';
export const VERIFICATION = 'VERIFICATION';
export const RATING = 'RATING';
export const PASS = 'PASS';
export const REJECT = 'REJECT';
export const REVOKE = 'REVOKE';
export const HIDE = 'HIDE';
export const SHOW = 'SHOW';
export const PIN = 'PIN';
export const UNPIN = 'UNPIN';
export const GRANT_VIP = 'GRANT_VIP';
export const CANCEL_VIP = 'CANCEL_VIP';
export const SET_TAGS = 'SET_TAGS';
export const TAG_TEAM = 'TEAM';
export const TAG_WORK = 'WORK';
export const TAG_BUSINESS = 'BUSINESS';
export const TAG_OPERATION = 'OPERATION';
export const TAG_SPONSOR_NEED = 'SPONSOR_NEED';
export const AVATAR_EMOJI = 'EMOJI';
export const AVATAR_IMAGE = 'IMAGE';
export const FILE_AVATAR = 'AVATAR';
export const FILE_PROJECT = 'PROJECT';
export const FILE_VERIFICATION = 'VERIFICATION';

export const ROLE_TYPES = new Set([AMBASSADOR, CLUB, BRAND]);
export const PROJECT_TYPES = new Set([SPONSOR, AMBASSADOR_RECRUIT]);
export const AVATAR_TYPES = new Set([AVATAR_EMOJI, AVATAR_IMAGE]);
export const FILE_SCENES = new Set([FILE_AVATAR, FILE_PROJECT, FILE_VERIFICATION]);
export const REVIEW_ACTIONS = new Set([PASS, REJECT]);
export const VERIFICATION_REVIEW_ACTIONS = new Set([PASS, REJECT, REVOKE]);
export const PROFILE_OPERATIONS = new Set([HIDE, SHOW, PIN, UNPIN, GRANT_VIP, CANCEL_VIP, SET_TAGS]);
export const PROJECT_OPERATIONS = new Set([HIDE, SHOW, PIN, UNPIN]);

const SM4_KEY = '0123456789abcdeffedcba9876543210';
const SM4_IV = 'fedcba98765432100123456789abcdef';
const SM4_OPTIONS = { mode: 'cbc', iv: SM4_IV };
const SNOWY_SM2_PRIVATE_KEY = '3037723d47292171677ec8bd7dc9af696c7472bc5f251b2cec07e65fdef22e25';
const ADMIN_ORIGINS = new Set(['https://campus.gfjianli.com', 'http://localhost:3200']);
const TOKEN_TTL = 8_592_000;
const CSRF_TTL = 7200;
const TOKEN_KEY = 'campus_admin_token:campus-admin:token:';
const SESSION_KEY = 'campus-admin:login-user:';
const USER_TOKENS = 'campus-admin:user-tokens:';
const CSRF_KEY = 'campus-circle:admin-csrf:';

export type CampusAdminSession = {
  id: string;
  account: string;
  name: string;
  accountType: string;
  permissions: string[];
  routes: string[];
};

export function text(value: unknown): string {
  if (Array.isArray(value)) return text(value[0]);
  if (value == null) return '';
  return String(value).trim();
}

export function optionalText(value: unknown): string | null {
  const trimmed = text(value);
  return trimmed ? trimmed : null;
}

export function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

export function intValue(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

export function flag(value: unknown): boolean {
  if (Buffer.isBuffer(value)) return value.length > 0 && value[0] === 1;
  return value === true || value === 1 || value === '1';
}

export function asDate(value: unknown): Date | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function cell(row: Row | undefined, key: string): unknown {
  return row?.[key];
}

export function cellText(row: Row | undefined, key: string): string | null {
  const value = cell(row, key);
  if (value == null) return null;
  return String(value);
}

export function cellNumber(row: Row | undefined, key: string): number {
  const value = Number(cell(row, key) ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export function sha256(value: string | null | undefined): string | null {
  if (!value) return null;
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function randomToken(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length }, () => alphabet[randomInt(alphabet.length)] ?? 'A').join('');
}

export function shanghaiDay(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function shanghaiStart(day = shanghaiDay()): Date {
  return new Date(`${day}T00:00:00+08:00`);
}

export function sm4Encrypt(value: string | null | undefined): string | null {
  if (!value) return null;
  return smCrypto.sm4.encrypt(value, SM4_KEY, SM4_OPTIONS);
}

export function sm4Decrypt(value: unknown): string | null {
  if (value == null || value === '') return value == null ? null : '';
  const source = String(value);
  try {
    const plain = smCrypto.sm4.decrypt(source, SM4_KEY, SM4_OPTIONS);
    return plain === '' ? source : plain;
  } catch {
    return source;
  }
}

export function decryptAdminPassword(encrypted: string, env: AppEnv): string {
  const key = env.ADMIN_SM2_PRIVATE_KEY || SNOWY_SM2_PRIVATE_KEY;
  try {
    return smCrypto.sm2.doDecrypt(encrypted, key, 1);
  } catch {
    throw campus(500, '密码解密失败');
  }
}

export function pageQuery(query: Record<string, unknown>, fallbackSize: number, maxSize: number) {
  const currentRaw = query.current;
  const sizeRaw = query.size;
  const current = currentRaw == null || currentRaw === '' ? 1 : Number(currentRaw);
  const size = sizeRaw == null || sizeRaw === '' ? fallbackSize : Number(sizeRaw);
  if (!Number.isInteger(current) || current < 1) throw campus(500, '页码不能小于1');
  if (!Number.isInteger(size) || size < 1) throw campus(500, '每页数量不能小于1');
  if (size > maxSize) throw campus(500, maxSize === 500 ? '每页数量不能超过500' : '每页数量不能超过100');
  return { current, size, offset: (current - 1) * size };
}

export function pageResult<T>(records: T[], total: number, current: number, size: number) {
  return { records, total, current, size, pages: size > 0 ? Math.ceil(total / size) : 0 };
}

export function requireBound(value: string, message: string, max: number, maxMessage: string) {
  if (!value) throw campus(500, message);
  if (value.length > max) throw campus(500, maxMessage);
}

export function limitLength(value: string, max: number, message: string) {
  if (value.length > max) throw campus(500, message);
}

export function limitList(values: string[], max: number, message: string, itemMessage: string) {
  if (values.length > max) throw campus(500, message);
  if (values.some((item) => item.length > 64)) throw campus(500, itemMessage);
}

export async function queryRows(db: CampusDb, statement: RawBuilder<unknown>): Promise<Row[]> {
  const result = await statement.execute(db);
  return result.rows as Row[];
}

export async function queryOne(db: CampusDb, statement: RawBuilder<unknown>): Promise<Row | undefined> {
  return (await queryRows(db, statement))[0];
}

export async function queryCount(db: CampusDb, statement: RawBuilder<unknown>): Promise<number> {
  const row = await queryOne(db, statement);
  return cellNumber(row, 'total');
}

export async function executeAffected(db: CampusDb, statement: RawBuilder<unknown>): Promise<number> {
  const result = await statement.execute(db);
  return Number(result.numAffectedRows ?? 0);
}

export async function insertRow(db: CampusDb, table: string, values: Record<string, unknown>) {
  if (!/^[a-z0-9_]+$/.test(table)) throw campus(500, '数据表不合法');
  const keys = Object.keys(values);
  await sql`
    INSERT INTO ${sql.raw(table)} (${sql.join(keys.map((key) => sql.raw(key)))})
    VALUES (${sql.join(keys.map((key) => sql`${values[key] ?? null}`))})
  `.execute(db);
}

export function newId(): string {
  return nextAdminId();
}

export function stamp(userId: string | null): Record<string, unknown> {
  return {
    id: newId(),
    delete_flag: 'NOT_DELETE',
    create_time: new Date(),
    create_user: userId,
    update_time: null,
    update_user: null,
  };
}

export async function withLock<T>(
  env: AppEnv,
  key: string,
  waitMs: number,
  leaseSeconds: number,
  busyMessage: string,
  fn: () => Promise<T>,
): Promise<T> {
  const redis = authRedis(env);
  const token = randomBytes(16).toString('hex');
  const started = Date.now();
  let locked = false;
  while (Date.now() - started <= waitMs) {
    const acquired = await redis.set(key, token, 'EX', leaseSeconds, 'NX');
    if (acquired === 'OK') {
      locked = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!locked) throw campus(121010, busyMessage);
  try {
    return await fn();
  } finally {
    if ((await redis.get(key)) === token) await redis.del(key);
  }
}

export function clientIp(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-for'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = value?.split(',')[0]?.trim();
  return first || request.ip || 'unknown';
}

export function deviceId(request: FastifyRequest): string {
  const device = request.headers['x-device-id'];
  const value = Array.isArray(device) ? device[0] : device;
  return value || request.headers['user-agent'] || '';
}

export async function recordReview(
  db: CampusDb,
  input: {
    businessType: string;
    businessId: string;
    version: number;
    action: string;
    beforeStatus: string;
    afterStatus: string;
    reason: string | null;
    operatorId: string;
  },
) {
  await insertRow(db, 'sc_campus_review_log', {
    ...stamp(input.operatorId),
    business_type: input.businessType,
    business_id: input.businessId,
    business_version: input.version,
    action: input.action,
    before_status: input.beforeStatus,
    after_status: input.afterStatus,
    reason: input.reason,
    operator_id: input.operatorId,
    operation_time: new Date(),
  });
}

export async function recordSensitive(
  db: CampusDb,
  request: FastifyRequest,
  userId: string,
  resourceType: string,
  resourceId: string,
  action: string,
  result: string,
) {
  await insertRow(db, 'sc_campus_sensitive_access_log', {
    ...stamp(userId),
    user_id: userId,
    resource_type: resourceType,
    resource_id: resourceId,
    action,
    result,
    operation_time: new Date(),
    ip_hash: sha256(clientIp(request)),
    device_hash: sha256(deviceId(request)),
  });
}

function cookieValue(request: FastifyRequest, name: string): string {
  const header = request.headers.cookie;
  if (!header) return '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

export function campusAdminToken(request: FastifyRequest): string {
  return (
    cookieValue(request, 'campus_admin_token') ||
    text(request.headers.campus_admin_token) ||
    text(request.query && (request.query as Record<string, unknown>).campus_admin_token)
  );
}

function sessionKey(token: string) {
  return `${SESSION_KEY}${token}`;
}

export async function saveCampusAdminSession(env: AppEnv, token: string, session: CampusAdminSession) {
  const redis = authRedis(env);
  await redis
    .multi()
    .set(`${TOKEN_KEY}${token}`, session.id, 'EX', TOKEN_TTL)
    .set(sessionKey(token), JSON.stringify(session), 'EX', TOKEN_TTL)
    .sadd(`${USER_TOKENS}${session.id}`, token)
    .expire(`${USER_TOKENS}${session.id}`, TOKEN_TTL)
    .exec();
}

export async function loadCampusAdminSession(env: AppEnv, token: string): Promise<CampusAdminSession | undefined> {
  if (!token) return undefined;
  const redis = authRedis(env);
  const raw = await redis.get(sessionKey(token));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as CampusAdminSession;
  } catch {
    return undefined;
  }
}

export async function campusLoginId(env: AppEnv, token: string): Promise<string | undefined> {
  if (!token) return undefined;
  const session = await loadCampusAdminSession(env, token);
  if (session) return session.id;
  const stored = await authRedis(env).get(`${TOKEN_KEY}${token}`);
  return stored && /^[0-9A-Za-z_-]+$/.test(stored) ? stored : undefined;
}

export async function kickCampusAdmin(env: AppEnv, userId: string) {
  const redis = authRedis(env);
  const tokens = await redis.smembers(`${USER_TOKENS}${userId}`);
  if (tokens.length === 0) return;
  await redis.del(
    ...tokens.flatMap((token) => [`${TOKEN_KEY}${token}`, sessionKey(token), `${CSRF_KEY}${sha256(token)}`]),
    `${USER_TOKENS}${userId}`,
  );
}

export function writeCampusCookie(reply: FastifyReply, request: FastifyRequest, token: string, clear: boolean) {
  const secure = request.protocol === 'https' || request.headers['x-forwarded-proto'] === 'https';
  const parts = [
    `campus_admin_token=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    ...(secure ? ['Secure'] : []),
    ...(clear ? ['Max-Age=0'] : []),
  ];
  reply.header('Set-Cookie', parts.join('; '));
}

export async function createCampusCsrf(env: AppEnv, token: string): Promise<string> {
  const csrf = randomToken(48);
  await authRedis(env).set(`${CSRF_KEY}${sha256(token)}`, csrf, 'EX', CSRF_TTL);
  return csrf;
}

export async function validateCampusCsrf(env: AppEnv, token: string, csrf: string): Promise<boolean> {
  if (!token || !csrf) return false;
  const expected = await authRedis(env).get(`${CSRF_KEY}${sha256(token)}`);
  if (!expected) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(csrf);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function removeCampusCsrf(env: AppEnv, token: string) {
  if (!token) return;
  await authRedis(env).del(`${CSRF_KEY}${sha256(token)}`);
}

export function assertAdminOrigin(request: FastifyRequest) {
  const origin = text(request.headers.origin);
  if (!origin || !ADMIN_ORIGINS.has(origin)) throw campus(403, '请求来源不受信任');
}

export async function assertCampusCsrf(env: AppEnv, request: FastifyRequest) {
  if (request.method === 'GET' || request.method === 'HEAD') return;
  assertAdminOrigin(request);
  const token = campusAdminToken(request);
  const csrf = text(request.headers['x-csrf-token']);
  if (!(await validateCampusCsrf(env, token, csrf))) {
    throw campus(403, 'CSRF校验失败，请刷新页面后重试');
  }
}

export function hasCampusPermission(session: CampusAdminSession, permission: string) {
  return session.permissions.includes('*') || session.permissions.includes(permission);
}

export async function guardRepeat(env: AppEnv, request: FastifyRequest, intervalMs: number) {
  const url = request.url.split('?')[0] ?? request.url;
  const key = `Cache:common-repeatSubmit:${url}`;
  const now = Date.now();
  const repeatParam = JSON.stringify(request.query ?? {});
  const redis = authRedis(env);
  const cached = await redis.get(key);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as Record<string, { repeatParam?: string; repeatTime?: number }>;
      const previous = parsed[url];
      if (previous?.repeatParam === repeatParam && previous.repeatTime != null) {
        const elapsed = now - previous.repeatTime;
        if (elapsed < intervalMs) {
          const seconds = Math.floor((intervalMs - elapsed) / 1000);
          if (seconds > 0) throw campus(500, `请求过于频繁，请${seconds}秒后再试`);
        }
      }
    } catch (error) {
      if (error instanceof CampusError) throw error;
    }
  }
  await redis.set(key, JSON.stringify({ [url]: { repeatParam, repeatTime: now } }), 'EX', 3600);
}

export function sendCampusError(reply: FastifyReply, error: CampusError) {
  return reply.code(200).send(fail(error.code, error.message));
}

export function isVipActive(row: Row | undefined): boolean {
  if (!row || !flag(row.vip_flag)) return false;
  const expire = asDate(row.vip_expire_time);
  return expire == null || expire.getTime() > Date.now();
}

export function ratingAverage(total: number, count: number): number {
  if (count === 0) return 0;
  return Math.round((total / count) * 10) / 10;
}
