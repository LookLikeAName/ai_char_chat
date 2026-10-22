import { Queue, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { SecretBox } from './crypto.ts';
import { createDb, runMigrations, waitForDb } from './db/client.ts';
import { RedisEventPublisher, subscribeEvents } from './events/bus.ts';
import { AGENT_QUEUE, REPLY_JOB_OPTIONS, type AgentJob, type JobQueue } from './jobs.ts';
import { setupObservability } from './observabilitySetup.ts';
import type { QueueInspector } from './routes/debug.ts';
import { WsHub } from './ws.ts';

const config = loadConfig();
const { db, pool } = createDb(config.databaseUrl);
await waitForDb(pool);
await runMigrations(db);

const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
const queue = new Queue<AgentJob>(AGENT_QUEUE, { connection: redis });
const jobs: JobQueue = {
  async add(job, opts) {
    await queue.add(job.kind, job, {
      ...REPLY_JOB_OPTIONS,
      delay: opts?.delayMs,
      removeOnComplete: 1000,
      removeOnFail: 1000,
    });
  },
};

const toDto = (j: Job<AgentJob>, delayed = false) => ({
  id: j.id ?? '',
  kind: j.data.kind,
  data: j.data as unknown as Record<string, unknown>,
  at: new Date(delayed ? j.timestamp + (j.opts.delay ?? 0) : j.timestamp).toISOString(),
  attempts: j.attemptsMade,
  failedReason: j.failedReason ?? null,
});
const inspector: QueueInspector = {
  async snapshot() {
    const [counts, delayed, active, failed] = await Promise.all([
      queue.getJobCounts('waiting', 'delayed', 'active', 'completed', 'failed'),
      queue.getDelayed(0, 99),
      queue.getActive(0, 49),
      queue.getFailed(0, 29),
    ]);
    return {
      counts,
      delayed: delayed.map((j) => toDto(j, true)).sort((a, b) => a.at.localeCompare(b.at)),
      active: active.map((j) => toDto(j)),
      failed: failed.map((j) => toDto(j)),
    };
  },
  async promote(jobId) {
    const job = await queue.getJob(jobId);
    if (!job || !(await job.isDelayed())) return false;
    await job.promote();
    return true;
  },
};

const hub = new WsHub();
const unsubscribe = await subscribeEvents(config.redisUrl, (e) => hub.broadcast(e));

const events = new RedisEventPublisher(redis);
setupObservability(db, events);
const app = await buildApp({
  db,
  box: new SecretBox(config.appSecret),
  events,
  jobs,
  redis,
  queue: inspector,
  hub,
  mediaDir: config.mediaDir,
  logger: true,
  appPassword: config.appPassword,
});
await app.listen({ port: config.port, host: config.host });
const pingTimer = setInterval(() => hub.ping(), 25_000);

async function shutdown() {
  clearInterval(pingTimer);
  await app.close();
  await unsubscribe();
  await queue.close();
  redis.disconnect();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
