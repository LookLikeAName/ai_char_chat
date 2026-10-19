// 環境變數集中在這裡讀取；缺少必要值時直接結束，避免帶著錯誤設定啟動。
export interface Config {
  databaseUrl: string;
  redisUrl: string;
  appSecret: string;
  mediaDir: string;
  port: number;
  host: string;
  /** 對話停下多久後整理記憶（開發時可以調短測試） */
  memoryIdleMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = ['DATABASE_URL', 'REDIS_URL', 'APP_SECRET'].filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`缺少環境變數：${missing.join(', ')}（見 .env.example）`);
  }
  if (env.APP_SECRET!.length < 16) throw new Error('APP_SECRET 至少要 16 個字元');
  return {
    databaseUrl: env.DATABASE_URL!,
    redisUrl: env.REDIS_URL!,
    appSecret: env.APP_SECRET!,
    mediaDir: env.MEDIA_DIR ?? './data/media',
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '0.0.0.0',
    memoryIdleMs: Number(env.MEMORY_IDLE_MS ?? 10 * 60 * 1000),
  };
}

export const VERSION = '0.1.0';
