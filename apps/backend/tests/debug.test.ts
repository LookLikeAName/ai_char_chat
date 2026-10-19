// 監控：事件 log、LLM 呼叫紀錄、debug API、WebSocket 訂閱（TEST_DATABASE_URL 沒設定時略過）
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ServerEvent } from '@acc/shared';
import { buildApp } from '../src/app.ts';
import { SecretBox } from '../src/crypto.ts';
import { createDb, runMigrations } from '../src/db/client.ts';
import { avatars, conversationMembers, conversations, eventLog, llmProfiles, llmTraces, messages } from '../src/db/schema.ts';
import type { AgentJob } from '../src/jobs.ts';
import type { FetchFn } from '../src/llm/index.ts';
import { MemoryLock } from '../src/lock.ts';
import { addMemories } from '../src/memory/store.ts';
import { configureObservability, logEvent, pruneObservability } from '../src/observability.ts';
import { ReplyEngine } from '../src/reply/engine.ts';
import { saveSettings } from '../src/services/settings.ts';
import { WsHub } from '../src/ws.ts';
import { appSettingsSchema } from '@acc/shared';
import { SAMPLE_PERSONA } from './fixtures/persona.ts';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('監控', () => {
  const { db, pool } = createDb(url ?? '');
  const box = new SecretBox('test-secret-0123456789');
  const published: ServerEvent[] = [];
  let capture = true;
  let jobs: AgentJob[];
  let app: FastifyInstance;
  let hub: WsHub;
  let avatarId: string;
  let conversationId: string;
  const fetchFn = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ messages: ['嗨嗨'], affinity_delta: 1, mood: { label: '開心', valence: 2, energy: 1 } }) } }],
        usage: { prompt_tokens: 50, completion_tokens: 10 },
      }),
    )) as unknown as FetchFn;

  beforeAll(async () => {
    await runMigrations(db);
  });

  beforeEach(async () => {
    await db.execute(
      sql`truncate settings, llm_profiles, avatars, conversations, conversation_members, messages, usage_log, user_profile, memories, relationships, avatar_state, life_logs, event_log, llm_traces cascade`,
    );
    published.length = 0;
    capture = true;
    jobs = [];
    configureObservability({ db, publish: async (e) => void published.push(e), captureContext: async () => capture });
    const [p] = await db
      .insert(llmProfiles)
      .values({ name: 't', provider: 'openai-compatible', baseUrl: 'http://llm.test/v1', model: 'm' })
      .returning();
    const [a] = await db.insert(avatars).values({ name: '小雨', persona: SAMPLE_PERSONA, llm: { profileId: p!.id, params: {} } }).returning();
    const [c] = await db.insert(conversations).values({ type: 'dm' }).returning();
    await db.insert(conversationMembers).values({ conversationId: c!.id, avatarId: a!.id });
    avatarId = a!.id;
    conversationId = c!.id;
    await saveSettings(db, appSettingsSchema.parse({ replyPacing: 'instant' }));
    hub = new WsHub();
    app = await buildApp({
      db,
      box,
      events: { publish: async (e) => void published.push(e) },
      jobs: { add: async (j) => void jobs.push(j) },
      hub,
      mediaDir: mkdtempSync(path.join(tmpdir(), 'acc-media-')),
      fetchFn,
    });
  });

  afterEach(async () => {
    configureObservability(null);
    await app.close();
  });

  afterAll(async () => {
    await pool.end();
  });

  const engine = () =>
    new ReplyEngine({ db, box, events: { publish: async () => {} }, lock: new MemoryLock(), fetchFn, sleep: async () => {}, random: () => 0.5 });

  it('回覆時記錄完整 context、解析結果與事件；訊息連到那次呼叫', async () => {
    await db.insert(messages).values({ conversationId, senderType: 'user', content: '嗨' });
    await engine().handle(conversationId);

    const [trace] = await db.select().from(llmTraces);
    expect(trace).toMatchObject({ purpose: 'reply', avatarId, conversationId, model: 'm', inputTokens: 50, ok: true });
    expect(trace!.request!.system).toContain('你是「小雨」');
    expect(trace!.request!.messages.at(-1)).toEqual({ role: 'user', content: '嗨' });
    expect(trace!.parsed).toMatchObject({ messages: ['嗨嗨'], affinityDelta: 1 });

    const [msg] = await db.select().from(messages).where(eq(messages.senderType, 'avatar'));
    expect(msg!.meta.traceId).toBe(trace!.id);

    const types = (await db.select().from(eventLog)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['reply.seen', 'memory.retrieve', 'reply.sent', 'state.updated']));
    const sent = (await db.select().from(eventLog).where(eq(eventLog.type, 'reply.sent')))[0]!;
    expect(sent).toMatchObject({ avatarId, conversationId, traceId: trace!.id });
    expect(published.some((e) => e.type === 'debug.trace')).toBe(true);
  });

  it('關閉「記錄完整 context」時只留下摘要', async () => {
    capture = false;
    await db.insert(messages).values({ conversationId, senderType: 'user', content: '嗨' });
    await engine().handle(conversationId);
    const [trace] = await db.select().from(llmTraces);
    expect(trace).toMatchObject({ request: null, response: null, ok: true });
  });

  it('送出訊息時記錄排程的決策', async () => {
    await app.inject({ method: 'POST', url: `/api/conversations/${conversationId}/messages`, payload: { content: '嗨' } });
    const [e] = await db.select().from(eventLog).where(eq(eventLog.type, 'reply.scheduled'));
    expect(e).toMatchObject({ category: 'reply', avatarId, conversationId });
    expect(e!.data).toMatchObject({ pacing: 'instant', plan: { reason: 'normal' } });
  });

  it('debug API：事件篩選、呼叫紀錄、用量、prompt 預覽、記憶檢索、手動操作', async () => {
    await db.insert(messages).values({ conversationId, senderType: 'user', content: '面試結束了' });
    await engine().handle(conversationId);
    await logEvent({ category: 'system', type: 'x', level: 'warn', message: '警告事件' });

    const warn = (await app.inject({ url: '/api/debug/events?level=warn' })).json();
    expect(warn.map((e: { message: string }) => e.message)).toEqual(['警告事件']);
    const byText = (await app.inject({ url: `/api/debug/events?q=${encodeURIComponent('回了')}` })).json();
    expect(byText).toHaveLength(1);
    const byAvatar = (await app.inject({ url: `/api/debug/events?avatarId=${avatarId}&category=state` })).json();
    expect(byAvatar.map((e: { type: string }) => e.type)).toEqual(['state.updated']);

    const traces = (await app.inject({ url: '/api/debug/traces' })).json();
    expect(traces).toHaveLength(1);
    const full = (await app.inject({ url: `/api/debug/traces/${traces[0].id}` })).json();
    expect(full.request.messages.at(-1).content).toBe('面試結束了');
    expect(full.response).toContain('嗨嗨');

    const usage = (await app.inject({ url: '/api/debug/usage' })).json();
    expect(usage).toEqual([expect.objectContaining({ purpose: 'reply', model: 'm', calls: 1, inputTokens: 50, outputTokens: 10 })]);

    const before = (await db.select().from(eventLog)).length;
    const preview = (await app.inject({ url: `/api/debug/preview/${conversationId}?mode=proactive` })).json();
    expect(preview.system).toContain('是你想主動傳訊息給對方');
    expect(preview.messages.at(-1).content).toContain('現在由你主動傳訊息');
    expect(preview.notes).toMatchObject({ avatar: '小雨', relationship: { stage: 'stranger' } });
    // 預覽沒有副作用
    expect((await db.select().from(eventLog)).length).toBe(before);

    await addMemories(db, null, [
      { avatarId, kind: 'event', content: '對方下週二要去面試', importance: 8 },
      { avatarId, kind: 'event', content: '對方喜歡爬山', importance: 3 },
    ]);
    const retrieved = (
      await app.inject({ method: 'POST', url: `/api/debug/avatars/${avatarId}/retrieve`, payload: { query: '面試準備' } })
    ).json();
    expect(retrieved.embedder).toBeNull();
    expect(retrieved.rows[0]).toMatchObject({ content: '對方下週二要去面試' });
    expect(retrieved.rows[0].relevance).toBeGreaterThan(retrieved.rows[1].relevance);

    await app.inject({ method: 'POST', url: `/api/debug/conversations/${conversationId}/reply-now` });
    await app.inject({ method: 'POST', url: `/api/debug/conversations/${conversationId}/extract-now` });
    await app.inject({ method: 'POST', url: '/api/debug/run/proactive-tick' });
    expect(jobs).toEqual([
      { kind: 'reply', conversationId, force: true },
      { kind: 'memory.extract', avatarId, conversationId, force: true },
      { kind: 'proactive.tick' },
    ]);

    const queue = (await app.inject({ url: '/api/debug/queue' })).json();
    expect(queue).toMatchObject({ counts: {}, delayed: [], replyPlans: [] });
  });

  it('清除超過保留天數的紀錄', async () => {
    await logEvent({ category: 'system', type: 'old', message: '舊事件' });
    await db.update(eventLog).set({ at: new Date(Date.now() - 10 * 86_400_000) });
    await logEvent({ category: 'system', type: 'new', message: '新事件' });
    await pruneObservability(db, 7);
    expect((await db.select().from(eventLog)).map((e) => e.type)).toEqual(['new']);
  });

  it('WebSocket：debug 事件只送給訂閱的分頁', async () => {
    const received: Record<string, string[]> = { a: [], b: [] };
    const open = async (name: 'a' | 'b') => {
      const ws = await app.injectWS('/ws', {}, { onInit: (s) => void s.on('message', (d) => received[name]!.push(JSON.parse(String(d)).type)) });
      return ws;
    };
    // injectWS 不會自動等 app 就緒（inject 會）
    await app.ready();
    const a = await open('a');
    const b = await open('b');
    a.send(JSON.stringify({ type: 'subscribe', topics: ['debug'] }));
    await new Promise((r) => setTimeout(r, 50));
    hub.broadcast({ type: 'debug.event', event: {} as never });
    hub.broadcast({ type: 'conversations.changed' });
    await new Promise((r) => setTimeout(r, 50));
    expect(received.a).toEqual(['hello', 'debug.event', 'conversations.changed']);
    expect(received.b).toEqual(['hello', 'conversations.changed']);
    a.terminate();
    b.terminate();
  });
});
