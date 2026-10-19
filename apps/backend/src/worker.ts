// 處理所有延遲工作：avatar 回覆、記憶萃取、定期整理印象。
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { loadConfig } from './config.ts';
import { SecretBox } from './crypto.ts';
import { createDb } from './db/client.ts';
import { avatars } from './db/schema.ts';
import { RedisEventPublisher, WORKER_HEARTBEAT_KEY } from './events/bus.ts';
import { AGENT_QUEUE, MEMORY_JOB_OPTIONS, REPLY_JOB_OPTIONS, type AgentJob } from './jobs.ts';
import { RedisLock } from './lock.ts';
import { embedderFromSettings } from './memory/embedder.ts';
import { extractMemories } from './memory/extract.ts';
import { reflect } from './memory/reflect.ts';
import { backfillEmbeddings } from './memory/store.ts';
import { ReplyEngine } from './reply/engine.ts';
import { loadSettings } from './services/settings.ts';

const HEARTBEAT_MS = 10_000;
/** 對話正被另一個工作處理時，多久後再試 */
const BUSY_RETRY_MS = 3000;
const KEEP = { removeOnComplete: 1000, removeOnFail: 1000 };

const config = loadConfig();
const { db, pool } = createDb(config.databaseUrl);
const box = new SecretBox(config.appSecret);
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
const queue = new Queue<AgentJob>(AGENT_QUEUE, { connection: redis });
const events = new RedisEventPublisher(redis);
const lock = new RedisLock(redis);
const ctx = { db, box };

const engine = new ReplyEngine({
  db,
  box,
  events,
  lock,
  // 每次回覆後排一次記憶萃取；只有最後一次（對話真的停下來後）會有事做
  onReplied: async (avatarId, conversationId) => {
    await queue.add('memory.extract', { kind: 'memory.extract', avatarId, conversationId }, {
      ...MEMORY_JOB_OPTIONS,
      ...KEEP,
      delay: config.memoryIdleMs + 5000,
    });
  },
});

async function handleExtract(avatarId: string, conversationId: string) {
  const key = `extract:${avatarId}:${conversationId}`;
  const token = await lock.acquire(key, 5 * 60 * 1000);
  if (!token) return 'busy';
  try {
    const settings = await loadSettings(db);
    const embedder = await embedderFromSettings(db, box, settings);
    const result = await extractMemories(ctx, settings, embedder, avatarId, conversationId, new Date(), config.memoryIdleMs);
    if (embedder) await backfillEmbeddings(db, embedder, avatarId);
    if (result === 'done') await events.publish({ type: 'avatar.state.changed', avatarId });
    return result;
  } finally {
    await lock.release(key, token);
  }
}

async function maintenance() {
  const settings = await loadSettings(db);
  if (!settings.utilityLlm) return;
  const embedder = await embedderFromSettings(db, box, settings).catch(() => null);
  for (const a of await db.select({ id: avatars.id }).from(avatars)) {
    try {
      if (await reflect(ctx, settings, embedder, a.id)) await events.publish({ type: 'avatar.state.changed', avatarId: a.id });
      if (embedder) await backfillEmbeddings(db, embedder, a.id);
    } catch (err) {
      console.error(`[worker] avatar ${a.id} 的定期整理失敗：`, (err as Error).message);
    }
  }
}

const worker = new Worker<AgentJob>(
  AGENT_QUEUE,
  async (job) => {
    const data = job.data;
    switch (data.kind) {
      case 'reply': {
        const result = await engine.handle(data.conversationId);
        if (result === 'busy') await queue.add('reply', data, { ...REPLY_JOB_OPTIONS, ...KEEP, delay: BUSY_RETRY_MS });
        return result;
      }
      case 'memory.extract': {
        const result = await handleExtract(data.avatarId, data.conversationId);
        if (result === 'busy') await queue.add('memory.extract', data, { ...MEMORY_JOB_OPTIONS, ...KEEP, delay: 30_000 });
        return result;
      }
      case 'maintenance':
        return maintenance();
    }
  },
  // 每個對話有自己的鎖，不同對話可以同時處理
  { connection: new Redis(config.redisUrl, { maxRetriesPerRequest: null }), concurrency: 8 },
);

worker.on('failed', (job, err) => {
  console.error(`[worker] 工作 ${job?.id}（${job?.data.kind}，第 ${job?.attemptsMade} 次）失敗：`, err.message);
  if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
  if (job.data.kind === 'reply') {
    engine.reportFailure(job.data.conversationId, err).catch((e) => console.error('[worker] 無法寫入失敗訊息：', e));
  }
});

await queue.upsertJobScheduler('maintenance', { every: 60 * 60 * 1000 }, { name: 'maintenance', data: { kind: 'maintenance' } });

async function beat() {
  await redis.set(WORKER_HEARTBEAT_KEY, new Date().toISOString(), 'EX', 60).catch(() => {});
}
await beat();
const timer = setInterval(beat, HEARTBEAT_MS);
console.log('[worker] 已啟動');

async function shutdown() {
  clearInterval(timer);
  await worker.close();
  await queue.close();
  await redis.del(WORKER_HEARTBEAT_KEY).catch(() => {});
  redis.disconnect();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
