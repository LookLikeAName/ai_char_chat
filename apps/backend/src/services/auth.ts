// 密碼登入。密碼用 scrypt 雜湊後存進 auth_state；也可以用環境變數 APP_PASSWORD 指定（優先）。
// 登入後發一個簽章過的 cookie：acc_session=<到期時間>.<版本>.<簽章>，伺服器不用存 session。
// 「版本」由 session_version 與密碼的指紋組成：改密碼或「登出所有裝置」後，舊的 cookie 都會失效。
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import type { SecretBox } from '../crypto.ts';
import type { Db } from '../db/client.ts';
import { authState } from '../db/schema.ts';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const AUTH_ID = 1;
export const SESSION_COOKIE = 'acc_session';
const REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;
/** 沒勾「記住我」：瀏覽器關掉 cookie 就沒了，伺服器端最多也只認 12 小時 */
const SHORT_MS = 12 * 60 * 60 * 1000;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

export interface AuthConfig {
  enabled: boolean;
  managedByEnv: boolean;
  /** 放進 cookie 的版本；換密碼或登出所有裝置時會變 */
  version: string;
  check: (password: string) => Promise<boolean>;
}

export class AuthService {
  private cache: { at: number; value: AuthConfig } | null = null;

  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
    private readonly envPassword: string | undefined,
  ) {}

  private async row() {
    const [row] = await this.db.select().from(authState).where(eq(authState.id, AUTH_ID));
    return row ?? { passwordHash: null, sessionVersion: 1 };
  }

  /** 每個請求都要檢查，所以快取 5 秒；這個行程裡改了設定會立刻清掉 */
  async config(): Promise<AuthConfig> {
    if (this.cache && Date.now() - this.cache.at < 5000) return this.cache.value;
    const row = await this.row();
    const env = this.envPassword;
    const fingerprint = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
    const value: AuthConfig = env
      ? {
          enabled: true,
          managedByEnv: true,
          version: `${row.sessionVersion}-${fingerprint(`env:${env}`)}`,
          check: async (pw) => {
            const a = createHash('sha256').update(pw).digest();
            const b = createHash('sha256').update(env).digest();
            return timingSafeEqual(a, b);
          },
        }
      : {
          enabled: !!row.passwordHash,
          managedByEnv: false,
          version: `${row.sessionVersion}-${fingerprint(row.passwordHash ?? '')}`,
          check: async (pw) => (row.passwordHash ? verifyPassword(pw, row.passwordHash) : false),
        };
    this.cache = { at: Date.now(), value };
    return value;
  }

  private invalidate() {
    this.cache = null;
  }

  async setPassword(next: string | null): Promise<void> {
    const passwordHash = next ? await hashPassword(next) : null;
    await this.db
      .insert(authState)
      .values({ id: AUTH_ID, passwordHash })
      .onConflictDoUpdate({ target: authState.id, set: { passwordHash, updatedAt: new Date() } });
    this.invalidate();
  }

  /** 讓所有裝置都要重新登入 */
  async revokeAll(): Promise<void> {
    const row = await this.row();
    await this.db
      .insert(authState)
      .values({ id: AUTH_ID, passwordHash: row.passwordHash, sessionVersion: row.sessionVersion + 1 })
      .onConflictDoUpdate({ target: authState.id, set: { sessionVersion: row.sessionVersion + 1, updatedAt: new Date() } });
    this.invalidate();
  }

  async issue(remember: boolean, now = Date.now()): Promise<{ value: string; maxAgeSec: number | null }> {
    const { version } = await this.config();
    const exp = now + (remember ? REMEMBER_MS : SHORT_MS);
    const payload = `${exp}.${version}`;
    return { value: `${payload}.${this.box.sign(payload)}`, maxAgeSec: remember ? REMEMBER_MS / 1000 : null };
  }

  async verify(cookie: string | undefined, now = Date.now()): Promise<boolean> {
    if (!cookie) return false;
    const i = cookie.lastIndexOf('.');
    if (i < 0) return false;
    const payload = cookie.slice(0, i);
    const sig = Buffer.from(cookie.slice(i + 1));
    const expected = Buffer.from(this.box.sign(payload));
    if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return false;
    const [exp, ...rest] = payload.split('.');
    if (!(Number(exp) > now)) return false;
    return rest.join('.') === (await this.config()).version;
  }
}

/** 登入失敗太多次就暫時擋住：同一個來源 5 次後開始，每多錯一次等待加倍，最多 15 分鐘 */
export class LoginLimiter {
  private readonly fails = new Map<string, { count: number; until: number; last: number }>();

  retryAfterMs(key: string, now = Date.now()): number {
    const f = this.fails.get(key);
    return f && f.until > now ? f.until - now : 0;
  }

  fail(key: string, now = Date.now()): void {
    const f = this.fails.get(key);
    // 一小時沒再錯就重新計算
    const count = f && now - f.last < 3_600_000 ? f.count + 1 : 1;
    const until = count >= 5 ? now + Math.min(15 * 60_000, 30_000 * 2 ** (count - 5)) : 0;
    this.fails.set(key, { count, until, last: now });
  }

  succeed(key: string): void {
    this.fails.delete(key);
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function sessionCookie(value: string, maxAgeSec: number | null, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(maxAgeSec === null ? [] : [`Max-Age=${maxAgeSec}`]),
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
