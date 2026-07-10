import { Redis } from 'ioredis';
import { QUEUE_CONFIG } from './config.js';

let client: Redis | null = null;
let lastHealthCheck: { ok: boolean; checkedAt: number } | null = null;
let lastErrorLogAt = 0;
const ERROR_LOG_INTERVAL_MS = 30_000;

export function getRedisClient(): Redis {
  if (!client) {
    client = new Redis(QUEUE_CONFIG.redisUrl, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      lazyConnect: true,
    });

    client.on('error', (error: Error) => {
      const now = Date.now();
      if (now - lastErrorLogAt >= ERROR_LOG_INTERVAL_MS) {
        lastErrorLogAt = now;
        console.error('[redis] connection error:', error.message);
      }
      lastHealthCheck = { ok: false, checkedAt: now };
    });
  }

  return client;
}

export async function connectRedis(): Promise<boolean> {
  const redis = getRedisClient();
  if (redis.status === 'ready') return true;

  try {
    await redis.connect();
    lastHealthCheck = { ok: true, checkedAt: Date.now() };
    return true;
  } catch (error) {
    console.error('[redis] failed to connect:', error);
    lastHealthCheck = { ok: false, checkedAt: Date.now() };
    return false;
  }
}

export async function isRedisHealthy(): Promise<boolean> {
  const redis = getRedisClient();
  try {
    if (redis.status !== 'ready') {
      await redis.connect();
    }
    const pong = await redis.ping();
    const ok = pong === 'PONG';
    lastHealthCheck = { ok, checkedAt: Date.now() };
    return ok;
  } catch {
    lastHealthCheck = { ok: false, checkedAt: Date.now() };
    return false;
  }
}

export function getLastRedisHealth() {
  return lastHealthCheck;
}

export async function closeRedis(): Promise<void> {
  if (!client) return;
  await client.quit();
  client = null;
}
