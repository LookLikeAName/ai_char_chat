import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Redis } from 'ioredis';
import type { SecretBox } from './crypto.ts';
import type { Db } from './db/client.ts';
import { HttpError } from './errors.ts';
import type { EventPublisher } from './events/bus.ts';
import type { JobQueue } from './jobs.ts';
import type { FetchFn } from './llm/index.ts';
import { avatarRoutes } from './routes/avatars.ts';
import { avatarStateRoutes } from './routes/avatarState.ts';
import { conversationRoutes } from './routes/conversations.ts';
import { debugRoutes, type QueueInspector } from './routes/debug.ts';
import { healthRoutes } from './routes/health.ts';
import { llmProfileRoutes } from './routes/llmProfiles.ts';
import { profileRoutes } from './routes/profile.ts';
import { settingsRoutes } from './routes/settings.ts';
import { transferRoutes } from './routes/transfer.ts';
import { usageRoutes } from './routes/usage.ts';
import { QuotaError } from './services/usage.ts';
import { WsHub } from './ws.ts';

export interface AppDeps {
  db: Db;
  box: SecretBox;
  events: EventPublisher;
  jobs: JobQueue;
  /** 健康檢查用；測試時可省略 */
  redis?: Redis;
  /** 監控頁的佇列操作；測試時可省略 */
  queue?: QueueInspector;
  hub: WsHub;
  mediaDir: string;
  fetchFn?: FetchFn;
  logger?: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 1024 * 1024 });
  app.decorate('deps', deps);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.message, details: err.details });
    }
    if (err instanceof QuotaError) return reply.status(429).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as Error).message });
    app.log.error(err);
    return reply.status(500).send({ error: '伺服器錯誤' });
  });

  mkdirSync(path.join(deps.mediaDir, 'avatars'), { recursive: true });
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  await app.register(fastifyStatic, { root: path.resolve(deps.mediaDir), prefix: '/media/', decorateReply: false });
  await app.register(websocket);

  app.get('/ws', { websocket: true }, (socket) => deps.hub.add(socket));

  await app.register(
    async (api) => {
      await api.register(healthRoutes);
      await api.register(settingsRoutes);
      await api.register(llmProfileRoutes);
      await api.register(avatarRoutes);
      await api.register(avatarStateRoutes);
      await api.register(conversationRoutes);
      await api.register(profileRoutes);
      await api.register(debugRoutes);
      await api.register(usageRoutes);
      await api.register(transferRoutes);
    },
    { prefix: '/api' },
  );
  return app;
}
