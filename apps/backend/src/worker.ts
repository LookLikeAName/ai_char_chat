// 處理所有延遲工作：avatar 回覆（之後還有主動發話、記憶整理…）
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { loadConfig } from './config.ts';
import { SecretBox } from './crypto.ts';
import { createDb } from './db/client.ts';
import { RedisEventPublisher, WORKER_HEARTBEAT_KEY } from './events/bus.ts';
import { AGENT_QUEUE, REPLY_JOB_OPTIONS, type AgentJob } from './jobs.ts';
import { RedisLock } from './lock.ts';
import { ReplyEngine } from './reply/engine.ts';

const HEARTBEAT_MS = 10_000;
/** 對話正被另一個工作處理時，多久後再試 */
const BUSY_RETRY_MS = 3000;

const config = loadConfig();
const { db, pool } = createDb(config.databaseUrl);
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
const queue = new Queue<AgentJob>(AGENT_QUEUE, { connection: redis });

const engine = new ReplyEngine({
  db,
  box: new SecretBox(config.appSecret),
  events: new RedisEventPublisher(redis),
  lock: new RedisLock(redis),
});

const worker = new Worker<AgentJob>(
  AGENT_QUEUE,
  async (job) => {
    switch (job.data.kind) {
      case 'reply': {
        const result = await engine.handle(job.data.conversationId);
        if (result === 'busy') {
          await queue.add('reply', job.data, {
            ...REPLY_JOB_OPTIONS,
            delay: BUSY_RETRY_MS,
            removeOnComplete: 1000,
            removeOnFail: 1000,
          });
        }
        return result;
      }
    }
  },
  // 每個對話有自己的鎖，不同對話可以同時處理
  { connection: new Redis(config.redisUrl, { maxRetriesPerRequest: null }), concurrency: 8 },
);

worker.on('failed', (job, err) => {
  console.error(`[worker] 工作 ${job?.id}（第 ${job?.attemptsMade} 次）失敗：`, err.message);
  if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
  if (job.data.kind === 'reply') {
    engine.reportFailure(job.data.conversationId, err).catch((e) => console.error('[worker] 無法寫入失敗訊息：', e));
  }
});

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
