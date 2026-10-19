// api 與 worker 之間的事件匯流排（Redis pub/sub）。worker 產生的訊息經這裡交給 api 推播。
import { Redis } from 'ioredis';
import type { ServerEvent } from '@acc/shared';

export const EVENTS_CHANNEL = 'acc:events';
export const WORKER_HEARTBEAT_KEY = 'acc:worker:heartbeat';

export interface EventPublisher {
  publish(event: ServerEvent): Promise<void>;
}

export class RedisEventPublisher implements EventPublisher {
  constructor(private readonly redis: Redis) {}
  async publish(event: ServerEvent): Promise<void> {
    await this.redis.publish(EVENTS_CHANNEL, JSON.stringify(event));
  }
}

/** 訂閱用的連線必須獨立（進入 subscribe 模式後不能下其他指令） */
export async function subscribeEvents(redisUrl: string, onEvent: (event: ServerEvent) => void): Promise<() => Promise<void>> {
  const sub = new Redis(redisUrl, { maxRetriesPerRequest: null });
  sub.on('message', (_channel, raw) => {
    try {
      onEvent(JSON.parse(raw) as ServerEvent);
    } catch {
      // 格式錯誤的事件直接丟掉
    }
  });
  await sub.subscribe(EVENTS_CHANNEL);
  return async () => {
    await sub.quit();
  };
}
