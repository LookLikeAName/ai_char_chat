// 群組：建立、排程、選人、依序回覆、點名接話、私密記憶、主動開話題（TEST_DATABASE_URL 沒設定時略過）
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { appSettingsSchema, type AppSettings } from '@acc/shared';
import { buildApp } from '../src/app.ts';
import { SecretBox } from '../src/crypto.ts';
import { createDb, runMigrations } from '../src/db/client.ts';
import { avatars, conversations, llmProfiles, messages } from '../src/db/schema.ts';
import type { AgentJob } from '../src/jobs.ts';
import type { FetchFn } from '../src/llm/index.ts';
import { MemoryLock } from '../src/lock.ts';
import { addMemories } from '../src/memory/store.ts';
import { proactiveTick } from '../src/proactive/tick.ts';
import { ReplyEngine } from '../src/reply/engine.ts';
import { getRelationship } from '../src/relationship/service.ts';
import { saveSettings } from '../src/services/settings.ts';
import { WsHub } from '../src/ws.ts';
import { SAMPLE_PERSONA } from './fixtures/persona.ts';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('群組', () => {
  const { db, pool } = createDb(url ?? '');
  const box = new SecretBox('test-secret-0123456789');
  let jobs: { job: AgentJob; delayMs?: number }[];
  let prompts: { who: string; body: any }[];
  /** 依 system prompt 裡的名字決定回覆 */
  let replyFor: (name: string, body: any) => unknown;
  const fetchFn = (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    const who = /你是「(.+?)」/.exec(body.messages[0].content)?.[1] ?? '?';
    prompts.push({ who, body });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(replyFor(who, body)) } }], usage: {} }));
  }) as unknown as FetchFn;
  let app: FastifyInstance;
  let ids: Record<string, string>;
  let groupId: string;
  let settings: AppSettings;

  const engine = () =>
    new ReplyEngine({
      db,
      box,
      events: { publish: async () => {} },
      lock: new MemoryLock(),
      fetchFn,
      sleep: async () => {},
      random: () => 0.5,
      enqueue: async (job, delayMs) => void jobs.push({ job, delayMs }),
    });

  async function say(content: string, senderType: 'user' | 'avatar' = 'user', who?: string) {
    await db.insert(messages).values({ conversationId: groupId, senderType, senderAvatarId: who ? ids[who] : null, content });
    await new Promise((r) => setTimeout(r, 5));
  }

  const transcript = async () =>
    (
      await db
        .select({ t: messages.senderType, a: messages.senderAvatarId, c: messages.content })
        .from(messages)
        .where(eq(messages.conversationId, groupId))
        .orderBy(asc(messages.createdAt), asc(messages.seq))
    ).map((m) => `${m.t === 'user' ? '我' : Object.entries(ids).find(([, v]) => v === m.a)?.[0]}：${m.c}`);

  beforeAll(async () => {
    await runMigrations(db);
  });

  beforeEach(async () => {
    await db.execute(
      sql`truncate settings, llm_profiles, avatars, conversations, conversation_members, messages, usage_log, user_profile, memories, relationships, avatar_state, life_logs, event_log, llm_traces cascade`,
    );
    jobs = [];
    prompts = [];
    replyFor = (name) => ({ messages: [`我是${name}`] });
    settings = appSettingsSchema.parse({ timezone: 'Asia/Taipei' });
    await saveSettings(db, settings);
    const [p] = await db
      .insert(llmProfiles)
      .values({ name: 't', provider: 'openai-compatible', baseUrl: 'http://llm.test/v1', model: 'm' })
      .returning();
    // 沒有作息表 → 一律在線；外向程度不同
    const persona = (extraversion: number, hobbies: string[], discretion = 80) => ({
      personality: { bigFive: { ...SAMPLE_PERSONA.personality.bigFive, extraversion } },
      preferences: { ...SAMPLE_PERSONA.preferences, hobbies, likes: [], favoriteTopics: [] },
      principles: { ...SAMPLE_PERSONA.principles, discretion },
    });
    ids = {};
    for (const [name, e, hobbies, discretion] of [
      ['小雨', 70, ['咖啡', '烘豆'], 80],
      ['阿哲', 20, ['寫程式', '電玩'], 10],
      ['美美', 90, ['逛街', '追劇'], 50],
    ] as const) {
      const [a] = await db
        .insert(avatars)
        .values({ name, bio: `${name}的簡介`, persona: persona(e, [...hobbies], discretion), llm: { profileId: p!.id, params: {} } })
        .returning();
      ids[name] = a!.id;
    }
    app = await buildApp({
      db,
      box,
      events: { publish: async () => {} },
      jobs: { add: async (job, opts) => void jobs.push({ job, delayMs: opts?.delayMs }) },
      hub: new WsHub(),
      mediaDir: mkdtempSync(path.join(tmpdir(), 'acc-media-')),
      fetchFn,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { title: '週末團', avatarIds: [ids['小雨'], ids['阿哲'], ids['美美']] },
    });
    expect(res.statusCode).toBe(201);
    groupId = res.json().id;
    jobs = [];
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('建立群組：出現在對話列表，成員之間建立「認識」的關係', async () => {
    const list = (await app.inject({ url: '/api/conversations' })).json();
    const g = list.find((c: { id: string }) => c.id === groupId);
    expect(g).toMatchObject({ type: 'group', title: '週末團' });
    expect(g.members).toHaveLength(3);
    const r = await getRelationship(db, ids['小雨']!, `avatar:${ids['阿哲']}`);
    expect(r.stage).toBe('acquaintance');
    const bad = await app.inject({ method: 'POST', url: '/api/conversations', payload: { title: 'x', avatarIds: [ids['小雨']] } });
    expect(bad.statusCode).toBe(400);
  });

  it('發話後等幾秒才開始；玩家還在打字就延後', async () => {
    await app.inject({ method: 'POST', url: `/api/conversations/${groupId}/messages`, payload: { content: '嗨' } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.job).toEqual({ kind: 'group.turn', conversationId: groupId });
    expect(jobs[0]!.delayMs).toBeGreaterThanOrEqual(3000);
    expect(await engine().handleGroupTurn(groupId)).toBe('early');

    await db.update(conversations).set({ turnDueAt: new Date(Date.now() - 1000) }).where(eq(conversations.id, groupId));
    await app.inject({ method: 'POST', url: `/api/conversations/${groupId}/typing` });
    expect(await engine().handleGroupTurn(groupId)).toBe('early');
    expect(jobs.at(-1)!.job).toEqual({ kind: 'group.turn', conversationId: groupId });
    expect(prompts).toHaveLength(0);
  });

  it('被點名的先回，後回的人看得到前面的人說了什麼', async () => {
    await say('阿哲你最近在寫什麼程式？');
    expect(await engine().handleGroupTurn(groupId, { force: true })).toBe('done');
    const t = await transcript();
    expect(t[1]).toBe('阿哲：我是阿哲');
    // 第二個回覆的人，prompt 裡有阿哲剛說的話（標上名字）
    const second = prompts[1]!;
    const history = second.body.messages.slice(1).map((m: { content: string }) => m.content).join('\n');
    expect(history).toContain('阿哲：我是阿哲');
    expect(second.body.messages[0].content).toContain('這一輪 阿哲 已經先回了');
    expect(prompts[0]!.body.messages[0].content).toContain('這一輪對方點名了你');
    // 已經處理過，再跑一次不會重複回
    await engine().handleGroupTurn(groupId, { force: true });
    expect((await transcript()).length).toBe(t.length);
  });

  it('一輪最多 4 則；不想說話的人可以不說', async () => {
    replyFor = (name) => (name === '美美' ? { messages: [] } : { messages: ['一', '二', '三'] });
    await say('大家晚安？');
    await engine().handleGroupTurn(groupId, { force: true });
    const avatarLines = (await transcript()).filter((l) => !l.startsWith('我：'));
    expect(avatarLines.length).toBeLessThanOrEqual(4);
    expect(avatarLines.some((l) => l.startsWith('美美'))).toBe(false);
  });

  it('回覆裡點名其他成員，那個人會接著回', async () => {
    replyFor = (name) => (name === '小雨' ? { messages: ['@阿哲 你上次說的那家咖啡店在哪'] } : { messages: [`我是${name}`] });
    await say('小雨，推薦一下咖啡');
    await engine().handleGroupTurn(groupId, { force: true });
    const t = await transcript();
    expect(t[1]).toContain('小雨：@阿哲');
    expect(t).toContain('阿哲：我是阿哲');
  });

  it('群組裡私訊得知的記憶會標記，並依口風提示', async () => {
    await addMemories(db, null, [{ avatarId: ids['阿哲']!, kind: 'event', content: '對方私下說他想換工作', importance: 9 }]);
    await say('阿哲最近怎樣');
    await engine().handleGroupTurn(groupId, { force: true });
    const p = prompts.find((x) => x.who === '阿哲')!.body.messages[0].content as string;
    expect(p).toContain('（私下得知）：對方私下說他想換工作');
    expect(p).toContain('你口風很鬆');
    expect(p).toContain('群組裡有你、對方（玩家），還有');
  });

  it('套用對其他成員的好感變化', async () => {
    replyFor = (name) => (name === '阿哲' ? { messages: ['哈哈'], others_affinity: { 美美: 2 } } : { messages: [] });
    await say('阿哲你覺得呢');
    await engine().handleGroupTurn(groupId, { force: true });
    const r = await getRelationship(db, ids['阿哲']!, `avatar:${ids['美美']}`);
    // 認識的起始好感 15，+2
    expect(r.affinity).toBe(17);
  });

  it('重試會強制開始一輪', async () => {
    await app.inject({ method: 'POST', url: `/api/conversations/${groupId}/retry` });
    expect(jobs).toEqual([{ job: { kind: 'group.turn', conversationId: groupId, force: true }, delayMs: undefined }]);
  });

  it('群組沉寂一陣子後有人主動開話題；其他人等玩家回應', async () => {
    const decisions = await proactiveTick({ db, box, fetchFn }, settings, async (j) => void jobs.push({ job: j }), {
      now: new Date('2026-10-19T12:00:00+08:00'),
      random: () => 0,
    });
    const groupJob = jobs.find((j) => j.job.kind === 'group.proactive');
    expect(groupJob).toBeDefined();
    expect(decisions.some((d) => d.reason.includes('週末團'))).toBe(true);

    const who = (groupJob!.job as { avatarId: string }).avatarId;
    replyFor = () => ({ messages: ['欸大家週末要幹嘛'] });
    expect(await engine().handleGroupProactive(groupId, who)).toBe('sent');
    const rows = await db.select().from(messages).where(and(eq(messages.conversationId, groupId), eq(messages.senderType, 'avatar')));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta.proactive).toBe(true);
    expect(prompts[0]!.body.messages[0].content).toContain('你想開個話題');
    // 沒有玩家的新訊息：這一輪什麼都不做
    expect(await engine().handleGroupTurn(groupId, { force: true })).toBe('done');
    expect(rows).toHaveLength(1);
  });
});
