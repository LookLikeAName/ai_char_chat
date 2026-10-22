import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { migrateLegacyProfileSettings } from './legacy.ts';
import * as schema from './schema.ts';

export type Db = ReturnType<typeof createDb>['db'];

export function createDb(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  // 資料庫重啟時閒置的連線會斷掉：記下來就好，連線池之後會重新連（沒有這個 handler，整個程式會當掉）
  pool.on('error', (err) => console.error('[db] 連線中斷：', err.message));
  const db = drizzle(pool, { schema });
  return { db, pool };
}

/** 資料庫還沒準備好時的錯誤（啟動中、復原中、連不上） */
const NOT_READY_CODES = ['57P03', '57P01', '08001', '08006', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT'];

export function isDbNotReady(err: unknown): boolean {
  const e = err as { code?: string; message?: string; cause?: unknown };
  if (e?.code && NOT_READY_CODES.includes(e.code)) return true;
  if (/starting up|not yet accepting|shutting down|terminating connection|Connection terminated/i.test(e?.message ?? '')) return true;
  return e?.cause ? isDbNotReady(e.cause) : false;
}

/**
 * 等資料庫可以連線再繼續。主機重開機時 Docker 會同時啟動所有容器（compose 的 depends_on 只在 `docker compose up` 時有用），
 * PostgreSQL 如果上次沒有正常關機，會先花一點時間自動復原；這段時間連線會被拒絕。
 */
export async function waitForDb(
  pool: Pick<pg.Pool, 'query'>,
  opts: { timeoutMs?: number; sleep?: (ms: number) => Promise<void>; log?: (msg: string) => void } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const started = Date.now();
  let delay = 1000;
  let warned = false;
  for (;;) {
    try {
      await pool.query('select 1');
      if (warned) log('[db] 資料庫已經可以連線');
      return;
    } catch (err) {
      if (!isDbNotReady(err) || Date.now() - started > timeoutMs) throw err;
      if (!warned) log(`[db] 資料庫還沒準備好（${(err as Error).message}），等它啟動…`);
      warned = true;
      await sleep(delay);
      delay = Math.min(Math.round(delay * 1.5), 5000);
    }
  }
}

/** migration 檔放在 apps/backend/drizzle；打包後與 dist 同層 */
export function migrationsFolder(): string {
  return process.env.MIGRATIONS_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');
}

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: migrationsFolder() });
  await migrateLegacyProfileSettings(db);
}
