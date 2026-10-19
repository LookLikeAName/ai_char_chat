import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { SecretBox } from './crypto.ts';
import { createDb, runMigrations } from './db/client.ts';
import { RedisEventPublisher, subscribeEvents } from './events/bus.ts';
import { AGENT_QUEUE, REPLY_JOB_OPTIONS, type AgentJob, type JobQueue } from './jobs.ts';
import { WsHub } from './ws.ts';

const config = loadConfig();
const { db, pool } = createDb(config.databaseUrl);
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

const hub = new WsHub();
const unsubscribe = await subscribeEvents(config.redisUrl, (e) => hub.broadcast(e));

const app = await buildApp({
  db,
  box: new SecretBox(config.appSecret),
  events: new RedisEventPublisher(redis),
  jobs,
  redis,
  hub,
  mediaDir: config.mediaDir,
  logger: true,
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
