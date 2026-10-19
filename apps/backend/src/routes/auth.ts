import type { FastifyInstance, FastifyRequest } from 'fastify';
import { loginSchema, passwordChangeSchema, type AuthStatusDto } from '@acc/shared';
import { HttpError, parseBody } from '../errors.ts';
import { clearSessionCookie, LoginLimiter, readCookie, SESSION_COOKIE, sessionCookie } from '../services/auth.ts';

/** 不用登入就能用的路徑：登入本身、健康檢查（docker 用） */
const PUBLIC = [/^\/api\/auth\/(status|login|logout)$/, /^\/api\/health$/];

export async function authRoutes(app: FastifyInstance) {
  const { auth } = app;
  const limiter = new LoginLimiter();
  const secure = (req: FastifyRequest) => req.protocol === 'https';
  const loggedIn = (req: FastifyRequest) => auth.verify(readCookie(req.headers.cookie, SESSION_COOKIE));

  app.get('/auth/status', async (req): Promise<AuthStatusDto> => {
    const c = await auth.config();
    return { enabled: c.enabled, authenticated: !c.enabled || (await loggedIn(req)), managedByEnv: c.managedByEnv };
  });

  app.post('/auth/login', async (req, reply) => {
    const { password, remember } = parseBody(loginSchema, req.body);
    const c = await auth.config();
    if (!c.enabled) return { ok: true };
    const wait = limiter.retryAfterMs(req.ip);
    if (wait) {
      reply.header('retry-after', Math.ceil(wait / 1000));
      throw new HttpError(429, `錯誤太多次，請 ${Math.ceil(wait / 1000)} 秒後再試`);
    }
    if (!(await c.check(password))) {
      limiter.fail(req.ip);
      throw new HttpError(401, '密碼不對');
    }
    limiter.succeed(req.ip);
    const { value, maxAgeSec } = await auth.issue(remember);
    reply.header('set-cookie', sessionCookie(value, maxAgeSec, secure(req)));
    return { ok: true };
  });

  app.post('/auth/logout', async (_req, reply) => {
    reply.header('set-cookie', clearSessionCookie());
    return { ok: true };
  });

  /** 設定、修改或移除密碼（已經有密碼時要先登入，並且輸入目前的密碼） */
  app.put('/auth/password', async (req, reply) => {
    const { current, next } = parseBody(passwordChangeSchema, req.body);
    const c = await auth.config();
    if (c.managedByEnv) throw new HttpError(409, '密碼由環境變數 APP_PASSWORD 設定，請改 .env');
    if (c.enabled && !(await c.check(current ?? ''))) throw new HttpError(403, '目前的密碼不對');
    await auth.setPassword(next);
    // 改完密碼，舊的 cookie 都失效；這台裝置直接換新的
    if (next) {
      const { value, maxAgeSec } = await auth.issue(true);
      reply.header('set-cookie', sessionCookie(value, maxAgeSec, secure(req)));
    }
    return { ok: true };
  });

  app.post('/auth/logout-all', async (req, reply) => {
    await auth.revokeAll();
    const { value, maxAgeSec } = await auth.issue(true);
    reply.header('set-cookie', sessionCookie(value, maxAgeSec, secure(req)));
    return { ok: true };
  });
}

/** 有設定密碼時，/api、/ws、/media 都要先登入 */
export function registerAuthGuard(app: FastifyInstance) {
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0]!;
    if (!/^\/(api|ws|media)(\/|$)/.test(url) || PUBLIC.some((r) => r.test(url))) return;
    const c = await app.auth.config();
    if (!c.enabled) return;
    if (await app.auth.verify(readCookie(req.headers.cookie, SESSION_COOKIE))) return;
    return reply.status(401).send({ error: '請先登入', code: 'unauthorized' });
  });
}
