import type { FastifyRequest } from 'fastify';
import { AppError } from '@/common/errors.js';
import type { AppEnv } from '@/config/env.js';
import { Redis } from 'ioredis';

let redisClient: Redis | undefined;

function getRedis(env: AppEnv): Redis {
  if (!redisClient) {
    redisClient = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false,
      connectTimeout: 5_000,
      commandTimeout: 5_000,
    });
    redisClient.on('error', () => undefined);
  }
  return redisClient;
}

function redisUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Stream isn't writeable") ||
    message.includes('Connection is closed') ||
    message.includes('ECONNREFUSED') ||
    message.includes('ETIMEDOUT') ||
    message.includes('Command timed out')
  );
}

async function whenRedisReady(redis: Redis): Promise<void> {
  if (redis.status === 'ready') return;
  if (redis.status === 'wait' || redis.status === 'end' || redis.status === 'close') {
    try {
      await redis.connect();
    } catch {
      // A reconnect may already be in progress.
    }
  }
  if (redis.status === 'ready') return;
  await new Promise<void>((resolve, reject) => {
    if (redis.status === 'ready') {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new AppError(503, '登录状态服务暂时不可用，请稍后重试'));
    }, 4_000);
    const onReady = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timer);
      redis.off('ready', onReady);
    };
    redis.once('ready', onReady);
  });
}

async function writeRedis<T>(env: AppEnv, task: (redis: Redis) => Promise<T>): Promise<T> {
  const run = async (redis: Redis) => {
    await whenRedisReady(redis);
    return task(redis);
  };
  try {
    return await run(getRedis(env));
  } catch (error) {
    if (error instanceof AppError || !redisUnavailable(error)) throw error;
    const current = redisClient;
    redisClient = undefined;
    current?.disconnect();
    return run(getRedis(env));
  }
}

export function requestToken(request: FastifyRequest): string | undefined {
  const tokenHeader =
    request.headers.token ??
    request.headers['x-offer-star-token'] ??
    request.headers.authorization?.replace(/^Bearer\s+/i, '');
  return Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
}

async function resolveLegacyToken(env: AppEnv, token: string): Promise<string | undefined> {
  try {
    const redis = getRedis(env);
    // Snowy uses Sa-Token client login with the `C` login type. The value of
    // token:C:token:<token> is the client_user ID. Keep the default namespace
    // as a fallback for old/admin tokens without changing Redis data.
    const clientId = await redis.get(`token:C:token:${token}`);
    if (clientId) return clientId;
    return (await redis.get(`token:token:${token}`)) ?? undefined;
  } catch {
    return undefined;
  }
}

export async function resolveAdminToken(env: AppEnv, token: string): Promise<string | undefined> {
  try {
    const redis = getRedis(env);
    const adminId = await redis.get(`token:B:token:${token}`);
    if (adminId) return adminId;
    return (await redis.get(`token:token:${token}`)) ?? undefined;
  } catch {
    return undefined;
  }
}

export async function saveAdminToken(env: AppEnv, token: string, userId: string): Promise<void> {
  await writeRedis(env, (redis) =>
    redis.set(`token:B:token:${token}`, userId, 'EX', env.ADMIN_TOKEN_TTL_SECONDS),
  );
}

export async function deleteAdminToken(env: AppEnv, token: string): Promise<void> {
  await writeRedis(env, (redis) => redis.del(`token:B:token:${token}`));
}

export async function saveClientToken(env: AppEnv, token: string, userId: string): Promise<void> {
  await writeRedis(env, (redis) =>
    redis.set(`token:C:token:${token}`, userId, 'EX', env.CLIENT_TOKEN_TTL_SECONDS),
  );
}

export async function deleteClientToken(env: AppEnv, token: string): Promise<void> {
  await writeRedis(env, (redis) => redis.del(`token:C:token:${token}`));
}

export async function pingAuthRedis(env: AppEnv): Promise<void> {
  await getRedis(env).ping();
}

export function authRedis(env: AppEnv): Redis {
  return getRedis(env);
}

export async function readAuthCache(env: AppEnv, key: string): Promise<string | null> {
  try {
    return await getRedis(env).get(key);
  } catch {
    return null;
  }
}

export async function readRedisSetSize(env: AppEnv, key: string): Promise<number> {
  try {
    return await getRedis(env).scard(key);
  } catch {
    return 0;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    userId: string | undefined;
  }
}

export function requireUser(env: AppEnv) {
  return async function authenticate(request: FastifyRequest): Promise<void> {
    const token = requestToken(request);

    if (env.TEST_AUTH_ENABLED && token === env.TEST_AUTH_TOKEN) {
      request.userId = env.TEST_USER_ID;
      return;
    }

    if (token) {
      const userId = await resolveLegacyToken(env, token);
      if (userId) {
        request.userId = userId;
        return;
      }
    }

    throw new AppError(401, '登录状态已失效');
  };
}

export async function closeAuthRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = undefined;
  }
}
