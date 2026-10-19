// 每個對話同時只能有一個回覆流程在跑。
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

export interface Lock {
  /** 取得鎖；拿不到時回傳 null */
  acquire(key: string, ttlMs: number): Promise<string | null>;
  release(key: string, token: string): Promise<void>;
}

// 只有持有者（token 相同）才能解鎖，避免逾時後誤解別人的鎖
const RELEASE_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export class RedisLock implements Lock {
  constructor(private readonly redis: Redis) {}

  async acquire(key: string, ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    const ok = await this.redis.set(`acc:lock:${key}`, token, 'PX', ttlMs, 'NX');
    return ok ? token : null;
  }

  async release(key: string, token: string): Promise<void> {
    await this.redis.eval(RELEASE_SCRIPT, 1, `acc:lock:${key}`, token);
  }
}

/** 測試用 */
export class MemoryLock implements Lock {
  private readonly held = new Map<string, string>();

  async acquire(key: string): Promise<string | null> {
    if (this.held.has(key)) return null;
    const token = randomUUID();
    this.held.set(key, token);
    return token;
  }

  async release(key: string, token: string): Promise<void> {
    if (this.held.get(key) === token) this.held.delete(key);
  }
}
