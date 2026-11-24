import COS from 'cos-nodejs-sdk-v5';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { AppError } from '@/common/errors.js';
import type { AppEnv } from '@/config/env.js';
import type { Database } from '@/infrastructure/database.js';

export type CosObject = {
  key: string;
  url: string;
};

type CosConfig = {
  secretId: string;
  secretKey: string;
  region: string;
  bucket: string;
};

let configDatabase: Kysely<Database> | undefined;
let databaseConfig: CosConfig | undefined;

export function bindCosConfigDatabase(db: Kysely<Database>) {
  configDatabase = db;
  databaseConfig = undefined;
}

function readEnvConfig(env: AppEnv): CosConfig | undefined {
  if (
    !env.TENCENT_COS_SECRET_ID ||
    !env.TENCENT_COS_SECRET_KEY ||
    !env.TENCENT_COS_REGION ||
    !env.TENCENT_COS_BUCKET
  ) {
    return undefined;
  }
  return {
    secretId: env.TENCENT_COS_SECRET_ID,
    secretKey: env.TENCENT_COS_SECRET_KEY,
    region: env.TENCENT_COS_REGION,
    bucket: env.TENCENT_COS_BUCKET,
  };
}

async function loadDatabaseConfig(db: Kysely<Database>): Promise<CosConfig> {
  const result = await sql<{ CONFIG_KEY: string; CONFIG_VALUE: string | null }>`
    SELECT CONFIG_KEY, CONFIG_VALUE
    FROM dev_config
    WHERE DELETE_FLAG = 'NOT_DELETE'
      AND CONFIG_KEY IN (
        'SNOWY_FILE_TENCENT_SECRET_ID',
        'SNOWY_FILE_TENCENT_SECRET_KEY',
        'SNOWY_FILE_TENCENT_REGION_ID',
        'SNOWY_FILE_TENCENT_DEFAULT_BUCKET_NAME'
      )
  `.execute(db);
  const values = new Map(
    result.rows.map((row) => [row.CONFIG_KEY, row.CONFIG_VALUE?.trim() ?? '']),
  );
  const secretId = values.get('SNOWY_FILE_TENCENT_SECRET_ID');
  const secretKey = values.get('SNOWY_FILE_TENCENT_SECRET_KEY');
  const region = values.get('SNOWY_FILE_TENCENT_REGION_ID');
  const bucket = values.get('SNOWY_FILE_TENCENT_DEFAULT_BUCKET_NAME');
  if (!secretId || !secretKey || !region || !bucket) {
    throw new AppError(503, '腾讯云存储未配置');
  }
  return { secretId, secretKey, region, bucket };
}

async function requireCosConfig(env: AppEnv): Promise<CosConfig> {
  const fromEnv = readEnvConfig(env);
  if (fromEnv) return fromEnv;
  if (databaseConfig) return databaseConfig;
  if (!configDatabase) throw new AppError(503, '腾讯云存储未配置');
  databaseConfig = await loadDatabaseConfig(configDatabase);
  return databaseConfig;
}

async function createClient(env: AppEnv) {
  const config = await requireCosConfig(env);
  return {
    config,
    cos: new COS({
      SecretId: config.secretId,
      SecretKey: config.secretKey,
      Timeout: env.AI_REQUEST_TIMEOUT_MS,
    }),
  };
}

function publicUrl(env: AppEnv, config: CosConfig, key: string) {
  if (env.TENCENT_COS_PUBLIC_BASE_URL) {
    return `${env.TENCENT_COS_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`;
  }
  return `https://${config.bucket}.cos.${config.region}.myqcloud.com/${key}`;
}

function objectKeyFromUrl(env: AppEnv, urlOrKey: string) {
  if (!/^https?:\/\//i.test(urlOrKey)) return urlOrKey.replace(/^\/+/, '');
  try {
    const url = new URL(urlOrKey);
    const configuredBase = env.TENCENT_COS_PUBLIC_BASE_URL
      ? new URL(env.TENCENT_COS_PUBLIC_BASE_URL)
      : undefined;
    if (configuredBase && url.origin === configuredBase.origin) {
      const basePath = configuredBase.pathname.replace(/\/$/, '');
      return decodeURIComponent(url.pathname.slice(basePath.length).replace(/^\/+/, ''));
    }
    return decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  } catch {
    throw new AppError(400, 'COS 文件地址格式不正确');
  }
}

export async function uploadToCos(
  env: AppEnv,
  body: Buffer,
  contentType: string | undefined,
  originalName: string | undefined,
): Promise<string> {
  const { config, cos } = await createClient(env);
  const extension = (originalName?.split('.').pop() || 'bin')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 8);
  const key = `resume-migration/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${extension || 'bin'}`;
  const object = {
    Bucket: config.bucket,
    Region: config.region,
    Key: key,
    Body: body,
    ...(contentType ? { ContentType: contentType } : {}),
  };
  await cos.putObject(object);
  return publicUrl(env, config, key);
}

export async function cosPublicUrl(env: AppEnv, key: string): Promise<string> {
  const config = await requireCosConfig(env);
  return publicUrl(env, config, key);
}

export async function uploadToCosKey(
  env: AppEnv,
  body: Buffer,
  contentType: string | undefined,
  key: string,
): Promise<string> {
  if (!key.startsWith('xingce/') || key.includes('..') || key.includes('\\')) {
    throw new AppError(400, '文件路径无效');
  }
  const { config, cos } = await createClient(env);
  await cos.putObject({
    Bucket: config.bucket,
    Region: config.region,
    Key: key,
    Body: body,
    ...(contentType ? { ContentType: contentType } : {}),
  });
  return publicUrl(env, config, key);
}

export async function deleteFromCos(env: AppEnv, urlOrKey: string): Promise<void> {
  const { config, cos } = await createClient(env);
  await cos.deleteObject({
    Bucket: config.bucket,
    Region: config.region,
    Key: objectKeyFromUrl(env, urlOrKey),
  });
}

export async function cosObjectExists(env: AppEnv, urlOrKey: string): Promise<boolean> {
  const { config, cos } = await createClient(env);
  try {
    await cos.headObject({
      Bucket: config.bucket,
      Region: config.region,
      Key: objectKeyFromUrl(env, urlOrKey),
    });
    return true;
  } catch (error) {
    const status = Number((error as { statusCode?: number }).statusCode);
    if (status === 404 || String((error as { code?: string }).code) === 'NoSuchKey') return false;
    throw error;
  }
}

export async function createCosDownloadUrl(
  env: AppEnv,
  urlOrKey: string,
  expires = 900,
): Promise<string> {
  const { config, cos } = await createClient(env);
  const key = objectKeyFromUrl(env, urlOrKey);
  if (env.TENCENT_COS_PUBLIC_BASE_URL) return publicUrl(env, config, key);
  const result = cos.getObjectUrl({
    Bucket: config.bucket,
    Region: config.region,
    Key: key,
    Sign: true,
    Expires: Math.max(1, Math.min(expires, 86_400)),
  });
  return result;
}

const xingceArchivePrefix = 'xingce/admin-sources/';

export async function archiveXingceSource(env: AppEnv, body: Buffer, filename: string, contentType: string) {
  const name = filename.replace(/[^\p{L}\p{N} ._()（）-]/gu, '_').slice(-160);
  const reverseTime = String(9_999_999_999_999 - Date.now()).padStart(13, '0');
  const key = `${xingceArchivePrefix}${reverseTime}-${randomUUID()}/${name}`;
  const { config, cos } = await createClient(env);
  await cos.putObject({
    Bucket: config.bucket, Region: config.region, Key: key, Body: body,
    ACL: 'private', ContentType: contentType, CacheControl: 'private, no-store',
    ContentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(name).replace(/[!'()*]/g, '_')}`,
  });
  return { key, name };
}

export async function listXingceSources(env: AppEnv, marker?: string) {
  const { config, cos } = await createClient(env);
  const result = await cos.getBucket({
    Bucket: config.bucket, Region: config.region, Prefix: xingceArchivePrefix, MaxKeys: 30,
    ...(marker?.startsWith(xingceArchivePrefix) ? { Marker: marker } : {}),
  });
  return {
    files: (result.Contents ?? []).map((file) => ({
      key: file.Key, name: file.Key.split('/').at(-1) ?? file.Key, size: Number(file.Size), createdAt: file.LastModified,
    })),
    next: result.NextMarker ?? (result.IsTruncated === 'true' ? result.Contents.at(-1)?.Key : undefined) ?? '',
  };
}

function assertXingceSource(key: string) {
  if (!key.startsWith(xingceArchivePrefix) || key.includes('\\') || key.split('/').includes('..')) {
    throw new AppError(400, '原始资料地址无效');
  }
}

export async function signXingceSource(env: AppEnv, key: string) {
  assertXingceSource(key);
  const { config, cos } = await createClient(env);
  return cos.getObjectUrl({ Bucket: config.bucket, Region: config.region, Key: key, Sign: true, Expires: 300 });
}

export async function readXingceSourceImage(env: AppEnv, key: string) {
  assertXingceSource(key);
  if (!/\.(png|jpe?g|webp)$/i.test(key)) throw new AppError(400, '只有原始图片可以截取');
  const { config, cos } = await createClient(env);
  const result = await cos.getObject({ Bucket: config.bucket, Region: config.region, Key: key });
  return result.Body;
}
