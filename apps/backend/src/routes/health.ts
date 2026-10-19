import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { HealthDto } from '@acc/shared';
import { VERSION } from '../config.ts';
import { WORKER_HEARTBEAT_KEY } from '../events/bus.ts';

const WORKER_STALE_MS = 30_000;

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async (): Promise<HealthDto> => {
    const { db, redis } = app.deps;
    const dbOk = await db
      .execute(sql`select 1`)
      .then(() => true)
      .catch(() => false);
    let redisOk = false;
    let lastSeen: string | null = null;
    if (redis) {
      try {
        lastSeen = await redis.get(WORKER_HEARTBEAT_KEY);
        redisOk = true;
      } catch {
        redisOk = false;
      }
    }
    const online = !!lastSeen && Date.now() - Date.parse(lastSeen) < WORKER_STALE_MS;
    return { ok: dbOk && redisOk && online, db: dbOk, redis: redisOk, worker: { online, lastSeen }, version: VERSION };
  });
}
