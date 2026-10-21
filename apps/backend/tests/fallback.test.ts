// 備援設定檔：被拒絕或呼叫失敗時改用另一個（TEST_DATABASE_URL 沒設定時略過 DB 的部分）
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { SecretBox } from '../src/crypto.ts';
import { createDb, runMigrations } from '../src/db/client.ts';
import { eventLog, llmProfiles, llmTraces, usageLog } from '../src/db/schema.ts';
import type { FetchFn } from '../src/llm/index.ts';
import { configureObservability } from '../src/observability.ts';
import { callWithBinding, refusalOf } from '../src/services/llmCall.ts';
import { WsHub } from '../src/ws.ts';

describe('refusalOf', () => {
  it('擋下的結束原因、要 JSON 卻回拒答算被拒絕；角色在對話裡婉拒不算', () => {
    const r = (text: string, finishReason: string | null = 'stop') => ({ text, finishReason, usage: { inputTokens: 0, outputTokens: 0 } });
    expect(refusalOf(r('', 'content_filter'), true)).toContain('content_filter');
    expect(refusalOf(r("I'm sorry, but I can't help with that."), true)).toContain('模型拒答');
    expect(refusalOf(r('抱歉，我無法提供這類內容。'), true)).toContain('模型拒答');
    expect(refusalOf(r('{"messages": ["抱歉，我不能這樣啦"]}'), true)).toBeNull();
    expect(refusalOf(r('抱歉，我無法提供這類內容。'), false)).toBeNull();
  });
});

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('改用備援設定檔', () => {
  const { db, pool } = createDb(url ?? '');
  const box = new SecretBox('test-secret-0123456789');
  const bodies: { host: string; body: any }[] = [];
  /** 依 host 決定怎麼回 */
  let behave: Record<string, (body: any) => Response>;
  const ok = (content: string, finish = 'stop') => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
  const fetchFn = (async (u: string, init: RequestInit) => {
    const host = new URL(u).host;
    const body = JSON.parse(init.body as string);
    bodies.push({ host, body });
    return behave[host]!(body);
  }) as unknown as FetchFn;
  const ctx = { db, box, fetchFn };
  let cloud: string;
  let local: string;
  let app: FastifyInstance;

  const add = async (name: string, host: string, extra: Partial<typeof llmProfiles.$inferInsert> = {}) =>
    (await db.insert(llmProfiles).values({ name, provider: 'openai-compatible', baseUrl: `http://${host}/v1`, model: name, ...extra }).returning())[0]!.id;
  const setFallback = (id: string, to: string, onRefusal = true, onError = true) =>
    db.update(llmProfiles).set({ fallback: { profileId: to, onRefusal, onError } }).where(eq(llmProfiles.id, id));
  const call = (profileId: string, opts: { fallback?: boolean; json?: boolean } = {}) =>
    callWithBinding(ctx, { profileId, params: { temperature: 0.7 } }, { messages: [{ role: 'user', content: '嗨' }], json: opts.json ?? true }, { purpose: 'reply', fallback: opts.fallback });

  beforeAll(async () => {
    await runMigrations(db);
    app = await buildApp({ db, box, events: { publish: async () => {} }, jobs: { add: async () => {} }, hub: new WsHub(), mediaDir: mkdtempSync(path.join(tmpdir(), 'acc-')), fetchFn });
  });

  beforeEach(async () => {
    bodies.length = 0;
    await db.execute(sql`truncate settings, llm_profiles, avatars, usage_log, event_log, llm_traces cascade`);
    configureObservability({ db, publish: async () => {}, captureContext: async () => true });
    cloud = await add('cloud', 'cloud.test');
    local = await add('local', 'local.test');
    behave = {
      'cloud.test': () => ok('{"messages": ["雲端"]}'),
      'local.test': () => ok('{"messages": ["地端"]}'),
    };
  });

  afterAll(async () => {
    configureObservability(null);
    await app.close();
    await pool.end();
  });

  it('呼叫失敗：改用備援，兩次都記錄，並留一筆事件', async () => {
    await setFallback(cloud, local);
    behave['cloud.test'] = () => new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), { status: 429 });
    const r = await call(cloud);
    expect(r).toMatchObject({ text: '{"messages": ["地端"]}', fellBack: true, profileId: local, model: 'local' });
    // 覆寫的參數照樣帶過去
    expect(bodies[1]!.body.temperature).toBe(0.7);
    const traces = await db.select().from(llmTraces);
    expect(traces.map((t) => [t.model, t.ok]).sort()).toEqual([['cloud', false], ['local', true]]);
    expect((await db.select().from(usageLog)).length).toBe(2);
    const [ev] = await db.select().from(eventLog).where(eq(eventLog.type, 'llm.fallback'));
    expect(ev!.message).toContain('「cloud」呼叫失敗');
  });

  it('被拒絕：要 JSON 卻回拒答、或內容被擋下，改用備援', async () => {
    await setFallback(cloud, local);
    behave['cloud.test'] = () => ok("I'm sorry, but I can't help with that.");
    expect((await call(cloud)).text).toContain('地端');
    behave['cloud.test'] = () => ok('', 'content_filter');
    expect((await call(cloud)).text).toContain('地端');
    behave['cloud.test'] = () => new Response(JSON.stringify({ error: { message: 'Your request was rejected by our safety system' } }), { status: 400 });
    expect((await call(cloud)).text).toContain('地端');
  });

  it('只勾了其中一種：另一種照原本的結果；沒設備援或關掉時不改用', async () => {
    await setFallback(cloud, local, false, true);
    behave['cloud.test'] = () => ok("I'm sorry, I can't help with that.");
    expect(await call(cloud)).toMatchObject({ fellBack: false, text: "I'm sorry, I can't help with that." });
    await setFallback(cloud, local, true, false);
    behave['cloud.test'] = () => new Response('{"error": "boom"}', { status: 500 });
    await expect(call(cloud)).rejects.toThrow('500');
    await setFallback(cloud, local);
    await expect(call(cloud, { fallback: false })).rejects.toThrow('500');
    expect(bodies.every((b) => b.host === 'cloud.test')).toBe(true);
  });

  it('互相當備援也不會無限循環；看不懂圖片的備援收到文字標記', async () => {
    await setFallback(cloud, local);
    await setFallback(local, cloud);
    behave['cloud.test'] = () => new Response('{"error": "down"}', { status: 503 });
    behave['local.test'] = () => new Response('{"error": "down too"}', { status: 503 });
    await expect(call(cloud)).rejects.toThrow('down too');
    expect(bodies.map((b) => b.host)).toEqual(['cloud.test', 'local.test']);

    bodies.length = 0;
    behave['local.test'] = () => ok('{"messages": ["看不到圖"]}');
    await db.update(llmProfiles).set({ vision: true }).where(eq(llmProfiles.id, cloud));
    await callWithBinding(
      ctx,
      { profileId: cloud, params: {} },
      { messages: [{ role: 'user', content: [{ type: 'image', mime: 'image/png', data: 'AAAA' }, { type: 'text', text: '你看' }] }], json: true },
      { purpose: 'reply' },
    );
    expect(bodies[0]!.body.messages[0].content[0].type).toBe('image_url');
    expect(bodies[1]!.body.messages[0].content).toBe('［圖片］\n你看');
  });

  it('設定檔 API：只有聊天用的能設、不能指向自己或圖片設定檔；被當成備援的不能刪', async () => {
    const put = (id: string, fallback: unknown, kind = 'chat') =>
      app.inject({ method: 'PUT', url: `/api/llm-profiles/${id}`, payload: { kind, name: 'cloud', provider: 'openai-compatible', baseUrl: 'http://cloud.test/v1', model: 'cloud', fallback } });
    const img = await add('pic', 'pic.test', { kind: 'image' });
    expect((await put(cloud, { profileId: cloud })).statusCode).toBe(400);
    expect((await put(cloud, { profileId: img })).statusCode).toBe(400);
    expect((await put(cloud, { profileId: local, onRefusal: false, onError: false })).statusCode).toBe(400);
    const r = await put(cloud, { profileId: local });
    expect(r.statusCode).toBe(200);
    expect(r.json().fallback).toEqual({ profileId: local, onRefusal: true, onError: true });
    const del = await app.inject({ method: 'DELETE', url: `/api/llm-profiles/${local}` });
    expect(del.statusCode).toBe(409);
    expect(del.json().error).toContain('備援');
  });
});
