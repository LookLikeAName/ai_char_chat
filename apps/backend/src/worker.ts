// 處理所有延遲工作：avatar 回覆、主動發話、記憶整理…（第 1 階段只有骨架與心跳）
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { loadConfig } from './config.ts';
import { createDb } from './db/client.ts';
import { WORKER_HEARTBEAT_KEY } from './events/bus.ts';
import { AGENT_QUEUE, type AgentJob } from './jobs.ts';

const HEARTBEAT_MS = 10_000;

const config = loadConfig();
const { pool } = createDb(config.databaseUrl);
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

const worker = new Worker<AgentJob>(
  AGENT_QUEUE,
  async (job) => {
    switch (job.data.kind) {
      case 'user-message':
        // 第 2 階段：產生 avatar 回覆
        console.log(`[worker] 收到玩家訊息 ${job.data.messageId}（對話 ${job.data.conversationId}）`);
        return;
    }
  },
  { connection: new Redis(config.redisUrl, { maxRetriesPerRequest: null }), concurrency: 4 },
);
worker.on('failed', (job, err) => console.error(`[worker] 工作 ${job?.id} 失敗：`, err));

async function beat() {
  await redis.set(WORKER_HEARTBEAT_KEY, new Date().toISOString(), 'EX', 60).catch(() => {});
}
await beat();
const timer = setInterval(beat, HEARTBEAT_MS);
console.log('[worker] 已啟動');

async function shutdown() {
  clearInterval(timer);
  await worker.close();
  await redis.del(WORKER_HEARTBEAT_KEY).catch(() => {});
  redis.disconnect();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
