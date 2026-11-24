import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '@/config/env.js';
import { authRedis, closeAuthRedis, resolveAdminToken } from '@/auth/request-user.js';

vi.mock('ioredis', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    Redis: class extends EventEmitter {
      status = 'connecting';
      get = vi.fn(async () => {
        if (this.status !== 'ready') throw new Error("Stream isn't writeable");
        return null;
      });
      quit = vi.fn(async () => 'OK');
    },
  };
});

const env = { REDIS_URL: 'redis://mock.invalid' } as AppEnv;

function ready() {
  const redis = authRedis(env);
  redis.status = 'ready';
  redis.emit('ready');
}

afterEach(async () => {
  await closeAuthRedis();
  vi.useRealTimers();
});

describe('管理员会话读取', () => {
  it('等待首次 Redis 连接就绪再读取有效会话', async () => {
    const redis = authRedis(env);
    vi.mocked(redis.get).mockResolvedValueOnce('模拟管理员');
    const session = resolveAdminToken(env, 'test-session');

    expect(redis.get).not.toHaveBeenCalled();
    ready();
    await expect(session).resolves.toBe('模拟管理员');
    expect(redis.get).toHaveBeenCalledWith('token:B:token:test-session');
  });

  it('查不到会话时保留旧键兼容，并返回未登录', async () => {
    ready();
    const redis = authRedis(env);
    await expect(resolveAdminToken(env, 'missing-session')).resolves.toBeUndefined();
    expect(redis.get).toHaveBeenNthCalledWith(2, 'token:token:missing-session');
  });

  it('连接超时返回服务暂不可用', async () => {
    vi.useFakeTimers();
    const session = resolveAdminToken(env, 'test-session');
    const result = expect(session).rejects.toMatchObject({ code: 503 });
    await vi.advanceTimersByTimeAsync(4_000);
    await result;
  });
});
