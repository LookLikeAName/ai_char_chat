// 登入：沒設密碼時不擋；設了之後 /api、/media、/ws 都要 cookie（TEST_DATABASE_URL 沒設定時略過）
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { SecretBox } from '../src/crypto.ts';
import { createDb, runMigrations } from '../src/db/client.ts';
import { AuthService, hashPassword, LoginLimiter, verifyPassword } from '../src/services/auth.ts';
import { WsHub } from '../src/ws.ts';

describe('密碼與限制', () => {
  it('scrypt 雜湊可以驗證，錯的密碼不行', async () => {
    const h = await hashPassword('correct horse');
    expect(h).toMatch(/^scrypt\$/);
    expect(await verifyPassword('correct horse', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });

  it('錯 5 次後開始擋，之後每多錯一次等待加倍', () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 4; i++) l.fail('ip', 0);
    expect(l.retryAfterMs('ip', 0)).toBe(0);
    l.fail('ip', 0);
    expect(l.retryAfterMs('ip', 0)).toBe(30_000);
    l.fail('ip', 0);
    expect(l.retryAfterMs('ip', 0)).toBe(60_000);
    expect(l.retryAfterMs('other', 0)).toBe(0);
    l.succeed('ip');
    expect(l.retryAfterMs('ip', 0)).toBe(0);
  });
});

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('登入', () => {
  const { db, pool } = createDb(url ?? '');
  const mediaDir = mkdtempSync(path.join(tmpdir(), 'acc-media-'));
  const box = new SecretBox('test-secret-0123456789');
  let app: FastifyInstance;
  const make = (appPassword?: string) =>
    buildApp({ db, box, events: { publish: async () => {} }, jobs: { add: async () => {} }, hub: new WsHub(), mediaDir, appPassword });

  const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie'] ?? '').split(';')[0]!;

  beforeAll(async () => {
    await runMigrations(db);
  });

  afterEach(async () => {
    await app?.close();
    // 其他測試檔用同一個資料庫，不能留著密碼
    await db.execute(sql`truncate auth_state`);
  });

  afterAll(async () => {
    await pool.end();
    rmSync(mediaDir, { recursive: true, force: true });
  });

  it('沒有密碼時不用登入', async () => {
    app = await make();
    expect((await app.inject({ method: 'GET', url: '/api/auth/status' })).json()).toEqual({ enabled: false, authenticated: true, managedByEnv: false });
    expect((await app.inject({ method: 'GET', url: '/api/avatars' })).statusCode).toBe(200);
  });

  it('設定密碼後：沒登入的請求被擋（健康檢查除外），登入後才能用；錯的密碼不行', async () => {
    app = await make();
    const set = await app.inject({ method: 'PUT', url: '/api/auth/password', payload: { next: 'hunter2hunter2' } });
    expect(set.statusCode).toBe(200);
    const mine = cookieOf(set);

    for (const u of ['/api/avatars', '/media/avatars/x.png', '/ws', '/api/settings']) {
      const res = await app.inject({ method: 'GET', url: u });
      expect(res.statusCode, u).toBe(401);
      expect(res.json()).toMatchObject({ code: 'unauthorized' });
    }
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).not.toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/avatars', headers: { cookie: mine } })).statusCode).toBe(200);

    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'nope' } })).statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'hunter2hunter2', remember: true } });
    expect(login.statusCode).toBe(200);
    expect(String(login.headers['set-cookie'])).toMatch(/HttpOnly.*SameSite=Lax.*Max-Age=2592000/);
    const other = cookieOf(login);
    const status = await app.inject({ method: 'GET', url: '/api/auth/status', headers: { cookie: other } });
    expect(status.json()).toEqual({ enabled: true, authenticated: true, managedByEnv: false });

    // 竄改簽章
    const forged = other.slice(0, -2) + (other.endsWith('AA') ? 'BB' : 'AA');
    expect((await app.inject({ method: 'GET', url: '/api/avatars', headers: { cookie: forged } })).statusCode).toBe(401);
  });

  it('不勾記住我：瀏覽器關掉就失效的 cookie', async () => {
    app = await make();
    await app.inject({ method: 'PUT', url: '/api/auth/password', payload: { next: 'hunter2hunter2' } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'hunter2hunter2' } });
    expect(String(login.headers['set-cookie'])).not.toContain('Max-Age');
  });

  it('改密碼要輸入目前的密碼；改完舊的 cookie 失效；登出所有裝置也一樣', async () => {
    app = await make();
    const first = cookieOf(await app.inject({ method: 'PUT', url: '/api/auth/password', payload: { next: 'hunter2hunter2' } }));
    const bad = await app.inject({ method: 'PUT', url: '/api/auth/password', headers: { cookie: first }, payload: { current: 'x', next: 'another-pass' } });
    expect(bad.statusCode).toBe(403);
    const changed = await app.inject({
      method: 'PUT',
      url: '/api/auth/password',
      headers: { cookie: first },
      payload: { current: 'hunter2hunter2', next: 'another-pass' },
    });
    expect(changed.statusCode).toBe(200);
    const second = cookieOf(changed);
    expect((await app.inject({ method: 'GET', url: '/api/avatars', headers: { cookie: first } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/avatars', headers: { cookie: second } })).statusCode).toBe(200);

    const laptop = cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'another-pass' } }));
    const all = await app.inject({ method: 'POST', url: '/api/auth/logout-all', headers: { cookie: second } });
    expect((await app.inject({ method: 'GET', url: '/api/avatars', headers: { cookie: laptop } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/avatars', headers: { cookie: cookieOf(all) } })).statusCode).toBe(200);

    // 移除密碼：不用登入了
    await app.inject({ method: 'PUT', url: '/api/auth/password', headers: { cookie: cookieOf(all) }, payload: { current: 'another-pass', next: null } });
    expect((await app.inject({ method: 'GET', url: '/api/avatars' })).statusCode).toBe(200);
  });

  it('同一個來源錯太多次會被暫時擋住', async () => {
    app = await make();
    await app.inject({ method: 'PUT', url: '/api/auth/password', payload: { next: 'hunter2hunter2' } });
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'x' } })).statusCode);
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
    // 換個 IP（經過 nginx 的 X-Forwarded-For）不受影響
    const elsewhere = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': '192.168.1.20' },
      payload: { password: 'hunter2hunter2' },
    });
    expect(elsewhere.statusCode).toBe(200);
  });

  it('APP_PASSWORD：用環境變數的密碼，網頁上不能改', async () => {
    app = await make('from-env-123');
    expect((await app.inject({ method: 'GET', url: '/api/auth/status' })).json()).toMatchObject({ enabled: true, managedByEnv: true });
    expect((await app.inject({ method: 'GET', url: '/api/avatars' })).statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'from-env-123' } });
    const c = cookieOf(login);
    expect((await app.inject({ method: 'GET', url: '/api/avatars', headers: { cookie: c } })).statusCode).toBe(200);
    const put = await app.inject({ method: 'PUT', url: '/api/auth/password', headers: { cookie: c }, payload: { current: 'from-env-123', next: 'something-else' } });
    expect(put.statusCode).toBe(409);
  });

  it('過期的 cookie 不算', async () => {
    const auth = new AuthService(db, box, 'pw-pw-pw-pw');
    const { value } = await auth.issue(false, 0);
    expect(await auth.verify(value, 1000)).toBe(true);
    expect(await auth.verify(value, 13 * 3600 * 1000)).toBe(false);
  });
});
