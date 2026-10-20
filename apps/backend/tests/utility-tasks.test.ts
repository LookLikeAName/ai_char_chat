// 依功能指定系統工具模型（TEST_DATABASE_URL 沒設定時略過 DB 的部分）
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { appSettingsSchema, utilityBinding, utilityProfileIds } from '@acc/shared';
import { buildApp } from '../src/app.ts';
import { SecretBox } from '../src/crypto.ts';
import { createDb, runMigrations } from '../src/db/client.ts';
import { llmProfiles } from '../src/db/schema.ts';
import { WsHub } from '../src/ws.ts';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

describe('utilityBinding', () => {
  it('有另外指定就用它，否則用預設；列出所有用到的設定檔', () => {
    const s = appSettingsSchema.parse({ utilityLlm: { profileId: A, params: { temperature: 0.3 } }, utilityByTask: { persona: { profileId: B } } });
    expect(utilityBinding(s, 'persona')).toEqual({ profileId: B, params: {} });
    expect(utilityBinding(s, 'summary')).toEqual({ profileId: A, params: { temperature: 0.3 } });
    expect(utilityProfileIds(s)).toEqual([A, B]);
    expect(utilityBinding(appSettingsSchema.parse({}), 'memory')).toBeNull();
    // 只指定了某個功能、沒有預設時，其他功能還是沒有
    const only = appSettingsSchema.parse({ utilityByTask: { memory: { profileId: B } } });
    expect(utilityBinding(only, 'memory')?.profileId).toBe(B);
    expect(utilityBinding(only, 'persona')).toBeNull();
  });
});

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('依功能指定系統工具模型', () => {
  const { db, pool } = createDb(url ?? '');
  const mediaDir = mkdtempSync(path.join(tmpdir(), 'acc-media-'));
  let app: FastifyInstance;
  const models: string[] = [];
  const fetchFn = async (_u: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    models.push(body.model);
    const content = body.messages[0].content.includes('角色設計師') ? '{"persona": {"basic.age": 27}}' : '{"issues": []}';
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: {} }));
  };
  let cheap: string;
  let good: string;
  let image: string;

  beforeAll(async () => {
    await runMigrations(db);
    app = await buildApp({
      db,
      box: new SecretBox('test-secret-0123456789'),
      events: { publish: async () => {} },
      jobs: { add: async () => {} },
      hub: new WsHub(),
      mediaDir,
      fetchFn: fetchFn as never,
    });
  });

  beforeEach(async () => {
    models.length = 0;
    await db.execute(sql`truncate settings, llm_profiles, usage_log cascade`);
    const add = async (model: string, kind: 'chat' | 'image' = 'chat') =>
      (await db.insert(llmProfiles).values({ name: model, kind, provider: 'openai-compatible', baseUrl: 'http://llm.test/v1', model }).returning())[0]!.id;
    cheap = await add('cheap');
    good = await add('good');
    image = await add('pic', 'image');
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    rmSync(mediaDir, { recursive: true, force: true });
  });

  const patch = (payload: unknown) => app.inject({ method: 'PATCH', url: '/api/settings', payload });

  it('補完角色用另外指定的模型，其他功能用預設', async () => {
    expect((await patch({ utilityLlm: { profileId: cheap, params: {} }, utilityByTask: { persona: { profileId: good, params: {} } } })).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: '/api/avatars/persona/generate', payload: { name: '小雨', bio: '店長', only: ['basic.age'] } });
    expect(models).toEqual(['good']);
    models.length = 0;
    // 沒有另外指定 summary：用預設
    await app.inject({ method: 'PUT', url: '/api/profile/preferences', payload: { nickname: '阿明' } });
    await app.inject({ method: 'POST', url: '/api/profile/summary/generate' });
    expect(models).toEqual(['cheap']);
  });

  it('只能選聊天用的設定檔；被指定的設定檔不能刪除；部分更新保留其他欄位', async () => {
    expect((await patch({ utilityByTask: { memory: { profileId: image, params: {} } } })).statusCode).toBe(400);
    await patch({ utilityByTask: { memory: { profileId: good, params: {} } } });
    expect((await app.inject({ method: 'DELETE', url: `/api/llm-profiles/${good}` })).statusCode).toBe(409);
    const s = (await patch({ timezone: 'Asia/Tokyo' })).json();
    expect(s.utilityByTask).toEqual({ memory: { profileId: good, params: {} } });
  });
});
