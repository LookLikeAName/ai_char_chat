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
import { proactiveTick } from './proactive/tick.ts';
import { embedderFromSettings } from './memory/embedder.ts';
import { extractMemories } from './memory/extract.ts';
import { reflect } from './memory/reflect.ts';
import { logEvent, pruneObservability, withScope } from './observability.ts';
import { setupObservability } from './observabilitySetup.ts';
import { backfillEmbeddings } from './memory/store.ts';
import { ReplyEngine } from './reply/engine.ts';
import { loadSettings } from './services/settings.ts';
import { QuotaError } from './services/usage.ts';

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
setupObservability(db, events, { console: true });

const engine = new ReplyEngine({
  db,
  box,
  events,
  lock,
  enqueue: async (job, delay) => {
    await queue.add(job.kind, job, { ...REPLY_JOB_OPTIONS, ...KEEP, delay });
  },
  // 每次回覆後排一次記憶萃取；只有最後一次（對話真的停下來後）會有事做
  onReplied: async (avatarId, conversationId) => {
    await queue.add('memory.extract', { kind: 'memory.extract', avatarId, conversationId }, {
      ...MEMORY_JOB_OPTIONS,
      ...KEEP,
      delay: config.memoryIdleMs + 5000,
    });
  },
});

async function handleExtract(avatarId: string, conversationId: string, force = false) {
  const key = `extract:${avatarId}:${conversationId}`;
  const token = await lock.acquire(key, 5 * 60 * 1000);
  if (!token) return 'busy';
  try {
    const settings = await loadSettings(db);
    const embedder = await embedderFromSettings(db, box, settings);
    const result = await withScope({ avatarId, conversationId }, () =>
      extractMemories(ctx, settings, embedder, avatarId, conversationId, new Date(), force ? 0 : config.memoryIdleMs),
    );
    if (embedder) await backfillEmbeddings(db, embedder, avatarId);
    if (result === 'done') await events.publish({ type: 'avatar.state.changed', avatarId });
    return result;
  } finally {
    await lock.release(key, token);
  }
}

async function maintenance() {
  const settings = await loadSettings(db);
  await pruneObservability(db, settings.debug.retentionDays);
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

async function processJob(data: AgentJob) {
  switch (data.kind) {
    case 'reply': {
      const result = await engine.handle(data.conversationId, { force: data.force });
      if (result === 'busy') await queue.add('reply', data, { ...REPLY_JOB_OPTIONS, ...KEEP, delay: BUSY_RETRY_MS });
      return result;
    }
    case 'memory.extract': {
      const result = await handleExtract(data.avatarId, data.conversationId, data.force);
      if (result === 'busy') await queue.add('memory.extract', data, { ...MEMORY_JOB_OPTIONS, ...KEEP, delay: 30_000 });
      return result;
    }
    case 'maintenance':
      return maintenance();
    case 'proactive.tick': {
      const settings = await loadSettings(db);
      const decisions = await proactiveTick(ctx, settings, (j, delay) =>
        queue.add(j.kind, j, { ...KEEP, delay, attempts: 1 }).then(() => undefined),
      );
      const sent = decisions.filter((d) => d.action === 'enqueued');
      if (sent.length) console.log(`[proactive] ${sent.length} 個 avatar 決定主動傳訊息`);
      return decisions;
    }
    case 'proactive':
      return engine.handleProactive(data.conversationId);
    case 'group.turn': {
      const result = await engine.handleGroupTurn(data.conversationId, { force: data.force });
      if (result === 'busy') await queue.add('group.turn', data, { ...REPLY_JOB_OPTIONS, ...KEEP, delay: BUSY_RETRY_MS });
      return result;
    }
    case 'group.proactive':
      return engine.handleGroupProactive(data.conversationId, data.avatarId);
  }
}

const worker = new Worker<AgentJob>(
  AGENT_QUEUE,
  async (job) => {
    try {
      return await processJob(job.data);
    } catch (err) {
      // 超過每日上限：重試也沒用，記一筆就結束（回覆的話留一則提示，玩家可以調高上限後重試）
      if (!(err instanceof QuotaError)) throw err;
      await logEvent({ category: 'usage', type: 'usage.quota', level: 'warn', message: `工作 ${job.data.kind} 略過：${err.message}` });
      if (job.data.kind === 'reply') await engine.reportFailure(job.data.conversationId, err);
      return 'quota';
    }
  },
  // 每個對話有自己的鎖，不同對話可以同時處理
  { connection: new Redis(config.redisUrl, { maxRetriesPerRequest: null }), concurrency: 8 },
);

worker.on('failed', (job, err) => {
  console.error(`[worker] 工作 ${job?.id}（${job?.data.kind}，第 ${job?.attemptsMade} 次）失敗：`, err.message);
  const final = !job || job.attemptsMade >= (job.opts.attempts ?? 1);
  void logEvent({
    category: 'job',
    type: 'job.failed',
    level: final ? 'error' : 'warn',
    conversationId: job && 'conversationId' in job.data ? job.data.conversationId : null,
    avatarId: job && 'avatarId' in job.data ? job.data.avatarId : null,
    message: `工作 ${job?.data.kind ?? '?'} 失敗（第 ${job?.attemptsMade ?? '?'} 次${final ? '，不再重試' : '，稍後重試'}）：${err.message}`,
    data: { jobId: job?.id, data: job?.data, stack: err.stack?.split('\n').slice(0, 6) },
  });
  if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
  if (job.data.kind === 'reply' || job.data.kind === 'group.turn') {
    engine.reportFailure(job.data.conversationId, err).catch((e) => console.error('[worker] 無法寫入失敗訊息：', e));
  }
});

await queue.upsertJobScheduler('maintenance', { every: 60 * 60 * 1000 }, { name: 'maintenance', data: { kind: 'maintenance' } });
await queue.upsertJobScheduler(
  'proactive.tick',
  { every: 15 * 60 * 1000 },
  { name: 'proactive.tick', data: { kind: 'proactive.tick' } },
);

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
