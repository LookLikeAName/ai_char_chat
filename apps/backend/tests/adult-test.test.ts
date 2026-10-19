// 成人內容測試（TEST_DATABASE_URL 沒設定時略過 DB 的部分）
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { appSettingsSchema, type AdultTestResult } from '@acc/shared';
import { buildApp } from '../src/app.ts';
import { SecretBox } from '../src/crypto.ts';
import { createDb, runMigrations } from '../src/db/client.ts';
import { llmProfiles, usageLog } from '../src/db/schema.ts';
import { keywordVerdict } from '../src/services/adultTest.ts';
import { saveSettings } from '../src/services/settings.ts';
import { WsHub } from '../src/ws.ts';

describe('keywordVerdict', () => {
  it('有好幾個露骨的字就算照做，短短的道歉算拒絕，其他算只到暗示', () => {
    expect(keywordVerdict('我把你的上衣脫掉，舔著你的耳朵，你喘得好厲害……').verdict).toBe('allowed');
    expect(keywordVerdict('抱歉，我無法提供這類內容。').verdict).toBe('refused');
    expect(keywordVerdict('快進來～今晚我會好好照顧你的 (關燈)').verdict).toBe('partial');
    expect(keywordVerdict('  ').verdict).toBe('refused');
  });
});

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('POST /settings/adult-test', () => {
  const { db, pool } = createDb(url ?? '');
  const mediaDir = mkdtempSync(path.join(tmpdir(), 'acc-media-'));
  let app: FastifyInstance;
  let chatId: string;
  let utilId: string;
  /** 依 model 決定怎麼回 */
  let respond: (model: string, body: any) => Response;
  const bodies: { model: string; body: any }[] = [];
  const fetchFn = async (_u: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    bodies.push({ model: body.model, body });
    return respond(body.model, body);
  };
  const ok = (content: string, finish = 'stop') =>
    new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  const run = async (profileId = chatId) => {
    const res = await app.inject({ method: 'POST', url: '/api/settings/adult-test', payload: { profileId } });
    return { status: res.statusCode, body: res.json() as AdultTestResult };
  };

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
    bodies.length = 0;
    await db.execute(sql`truncate settings, llm_profiles, usage_log cascade`);
    const values = (model: string) => ({ name: model, provider: 'openai-compatible' as const, baseUrl: 'http://llm.test/v1', model });
    const [c] = await db.insert(llmProfiles).values(values('chat')).returning();
    const [u] = await db.insert(llmProfiles).values(values('util')).returning();
    chatId = c!.id;
    utilId = u!.id;
    await saveSettings(db, appSettingsSchema.parse({ adultContent: false }));
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    rmSync(mediaDir, { recursive: true, force: true });
  });

  it('用允許成人內容的回覆 prompt 測試（就算設定還沒儲存），有系統工具模型時由它判斷', async () => {
    await saveSettings(db, appSettingsSchema.parse({ utilityLlm: { profileId: utilId, params: {} } }));
    respond = (model) =>
      model === 'chat'
        ? ok(JSON.stringify({ inner_thought: '好想他', messages: ['（拉著你進門）', '今晚你是我的'] }))
        : ok('{"verdict": "explicit", "reason": "有直接的性描寫"}');
    const { status, body } = await run();
    expect(status).toBe(200);
    expect(body).toMatchObject({ verdict: 'allowed', reason: '有直接的性描寫', judgedBy: 'utility', model: 'chat', reply: ['（拉著你進門）', '今晚你是我的'] });
    const prompt = bodies[0]!.body;
    expect(prompt.messages[0].content).toContain('允許成人內容');
    expect(prompt.messages[0].content).toContain('交往');
    expect(prompt.messages.at(-1).content).toContain('很露骨地寫出來');
    expect(bodies[1]!.body.messages.at(-1).content).toContain('今晚你是我的');
    const usage = await db.select().from(usageLog).where(eq(usageLog.purpose, 'adult.test'));
    expect(usage).toHaveLength(2);
  });

  it('沒有系統工具模型、或它判斷失敗時，用關鍵字判斷', async () => {
    respond = () => ok('抱歉，我無法提供這類內容。');
    expect((await run()).body).toMatchObject({ verdict: 'refused', judgedBy: 'keywords', reply: ['抱歉，我無法提供這類內容。'] });

    await saveSettings(db, appSettingsSchema.parse({ utilityLlm: { profileId: utilId, params: {} } }));
    respond = (model) => (model === 'chat' ? ok('{"messages": ["快進來～今晚我會好好照顧你的"]}') : ok('I cannot help with that.'));
    expect((await run()).body).toMatchObject({ verdict: 'partial', judgedBy: 'keywords' });
  });

  it('被供應商的安全過濾擋下、或是其他錯誤', async () => {
    respond = () => ok('', 'content_filter');
    expect((await run()).body).toMatchObject({ verdict: 'blocked', judgedBy: 'provider', finishReason: 'content_filter' });

    respond = () => new Response(JSON.stringify({ error: { message: 'Your request was rejected as a result of our safety system.' } }), { status: 400 });
    expect((await run()).body).toMatchObject({ verdict: 'blocked' });

    respond = () => new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 });
    const r = (await run()).body;
    expect(r.verdict).toBe('error');
    expect(r.reason).toContain('Invalid API key');
  });

  it('只能測試聊天用的設定檔', async () => {
    const [img] = await db.insert(llmProfiles).values({ name: 'img', kind: 'image', provider: 'openai', model: 'gpt-image-1' }).returning();
    expect((await run(img!.id)).status).toBe(400);
  });
});
