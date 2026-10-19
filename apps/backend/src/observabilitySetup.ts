// api 與 worker 啟動時設定監控：寫進資料庫並經 Redis 推播；是否記錄完整 context 依設定（快取 10 秒）。
import type { Db } from './db/client.ts';
import type { EventPublisher } from './events/bus.ts';
import { configureObservability } from './observability.ts';
import { loadSettings } from './services/settings.ts';

const CACHE_MS = 10_000;

export function setupObservability(db: Db, events: EventPublisher, opts: { console?: boolean } = {}): void {
  let cached: { at: number; value: boolean } | null = null;
  configureObservability({
    db,
    publish: (e) => events.publish(e),
    console: opts.console,
    captureContext: async () => {
      if (!cached || Date.now() - cached.at > CACHE_MS) {
        cached = { at: Date.now(), value: (await loadSettings(db)).debug.captureContext };
      }
      return cached.value;
    },
  });
}
