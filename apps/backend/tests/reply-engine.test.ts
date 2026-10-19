// 回覆流程：真的 PostgreSQL + 假的 LLM（TEST_DATABASE_URL 沒設定時略過）
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import type { ServerEvent } from '@acc/shared';
import { SecretBox } from '../src/crypto.ts';
import { createDb, runMigrations } from '../src/db/client.ts';
import { avatars, conversationMembers, conversations, llmProfiles, messages, usageLog } from '../src/db/schema.ts';
import type { FetchFn } from '../src/llm/index.ts';
import { MemoryLock } from '../src/lock.ts';
import { ReplyEngine } from '../src/reply/engine.ts';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('ReplyEngine', () => {
  const { db, pool } = createDb(url ?? '');
  const box = new SecretBox('test-secret-0123456789');
  const events: ServerEvent[] = [];
  let lock: MemoryLock;
  /** 每次 LLM 呼叫依序取一個回應；也可以是函式（可在呼叫期間插入訊息） */
  let responses: (string | (() => Promise<string> | string))[];
  let llmBodies: any[];
  let onSleep: (() => Promise<void>) | null;
  let conversationId: string;
  let avatarId: string;

  const fetchFn = (async (_u: string, init: RequestInit) => {
    llmBodies.push(JSON.parse(init.body as string));
    const next = responses.shift();
    if (next === undefined) return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 });
    const content = typeof next === 'function' ? await next() : next;
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  }) as unknown as FetchFn;

  const engine = () =>
    new ReplyEngine({
      db,
      box,
      events: { publish: async (e) => void events.push(e) },
      lock,
      fetchFn,
      sleep: async () => {
        if (onSleep) await onSleep();
      },
      random: () => 0.5,
      now: () => new Date('2026-10-19T12:00:00Z'),
    });

  async function userSays(content: string) {
    await db.insert(messages).values({ conversationId, senderType: 'user', content });
    // 確保下一則的時間戳嚴格較晚
    await new Promise((r) => setTimeout(r, 5));
  }

  async function transcript() {
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt), asc(messages.seq));
    return rows.map((r) => `${r.senderType}:${r.content}`);
  }

  const reply = (...msgs: string[]) => JSON.stringify({ inner_thought: '想一下', messages: msgs });

  beforeAll(async () => {
    await runMigrations(db);
  });

  beforeEach(async () => {
    await db.execute(sql`truncate settings, llm_profiles, avatars, conversations, conversation_members, messages, usage_log cascade`);
    events.length = 0;
    lock = new MemoryLock();
    responses = [];
    llmBodies = [];
    onSleep = null;
    const [p] = await db
      .insert(llmProfiles)
      .values({ name: 't', provider: 'openai-compatible', baseUrl: 'http://llm.test/v1', model: 'm', defaults: { temperature: 0.5 } })
      .returning();
    const [a] = await db
      .insert(avatars)
      .values({ name: '小雨', bio: '咖啡店店長', llm: { profileId: p!.id, params: { temperature: 1.2 } } })
      .returning();
    const [c] = await db.insert(conversations).values({ type: 'dm' }).returning();
    await db.insert(conversationMembers).values({ conversationId: c!.id, avatarId: a!.id });
    conversationId = c!.id;
    avatarId = a!.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('回覆玩家：多則訊息依序送出，第一則帶內心想法，並發出已讀與輸入中事件', async () => {
    await userSays('嗨');
    responses = [reply('嗨嗨', '今天店裡超忙')];
    expect(await engine().handle(conversationId)).toBe('done');

    expect(await transcript()).toEqual(['user:嗨', 'avatar:嗨嗨', 'avatar:今天店裡超忙']);
    const [first] = await db.select().from(messages).where(eq(messages.content, '嗨嗨'));
    expect(first!.meta).toEqual({ innerThought: '想一下' });
    expect(llmBodies[0]).toMatchObject({ temperature: 1.2, response_format: { type: 'json_object' } });
    expect(llmBodies[0].messages[0].content).toContain('你是「小雨」');

    const kinds = events.map((e) => (e.type === 'typing' ? `typing:${e.typing}` : e.type));
    expect(kinds).toEqual([
      'conversation.seen',
      'typing:true',
      'message.created',
      'typing:false',
      'typing:true',
      'message.created',
      'typing:false',
    ]);
    const [usage] = await db.select().from(usageLog);
    expect(usage).toMatchObject({ purpose: 'reply', avatarId, ok: true, inputTokens: 10, outputTokens: 5 });
  });

  it('已經回過就不會重複回（重複投遞的工作是安全的）', async () => {
    await userSays('嗨');
    responses = [reply('嗨')];
    await engine().handle(conversationId);
    await engine().handle(conversationId);
    expect(llmBodies).toHaveLength(1);
    expect(await transcript()).toEqual(['user:嗨', 'avatar:嗨']);
  });

  it('連續的玩家訊息合併成一次回覆', async () => {
    await userSays('嗨');
    await userSays('在嗎');
    responses = [reply('在啊')];
    await engine().handle(conversationId);
    expect(llmBodies).toHaveLength(1);
    expect(llmBodies[0].messages.at(-1)).toEqual({ role: 'user', content: '嗨\n在嗎' });
  });

  it('產生回覆時玩家又傳訊息：整輪重來，連同新訊息一起回', async () => {
    await userSays('嗨');
    responses = [
      async () => {
        await userSays('欸我跟你說');
        return reply('（這則不該送出）');
      },
      reply('怎麼了？'),
    ];
    await engine().handle(conversationId);
    expect(await transcript()).toEqual(['user:嗨', 'user:欸我跟你說', 'avatar:怎麼了？']);
    expect(llmBodies[1].messages.at(-1).content).toBe('嗨\n欸我跟你說');
  });

  it('送出幾則之後玩家插話：停止剩下的，下一輪回新訊息', async () => {
    await userSays('嗨');
    responses = [reply('第一則', '第二則'), reply('喔你說')];
    let posted = 0;
    onSleep = async () => {
      // 第一則送出後、打第二則的期間，玩家插話（只插一次）
      const n = (await transcript()).filter((t) => t.startsWith('avatar:')).length;
      if (n === 1 && posted === 0) {
        posted++;
        await userSays('等等');
      }
    };
    await engine().handle(conversationId);
    expect(await transcript()).toEqual(['user:嗨', 'avatar:第一則', 'user:等等', 'avatar:喔你說']);
  });

  it('格式錯誤時提醒一次；還是不行就把純文字當訊息', async () => {
    await userSays('嗨');
    responses = ['嗨～', '還是純文字'];
    await engine().handle(conversationId);
    expect(llmBodies).toHaveLength(2);
    expect(llmBodies[1].messages.at(-1).content).toContain('系統提醒');
    expect(await transcript()).toEqual(['user:嗨', 'avatar:嗨～']);
  });

  it('沒有綁定 LLM：留一則提示，同樣的提示不重複', async () => {
    await db.update(avatars).set({ llm: null }).where(eq(avatars.id, avatarId));
    await userSays('嗨');
    await engine().handle(conversationId);
    await userSays('哈囉');
    await engine().handle(conversationId);
    const t = await transcript();
    expect(t.filter((x) => x.startsWith('system:'))).toHaveLength(1);
    expect(t[1]).toContain('還沒有設定大腦');
    // 沒有大腦就不會「已讀」
    expect(events.some((e) => e.type === 'conversation.seen')).toBe(false);
  });

  it('另一個流程持有鎖時回傳 busy', async () => {
    await userSays('嗨');
    await lock.acquire(`reply:${conversationId}`);
    expect(await engine().handle(conversationId)).toBe('busy');
  });

  it('LLM 失敗時丟出錯誤、釋放鎖，reportFailure 留下錯誤訊息', async () => {
    await userSays('嗨');
    responses = [];
    await expect(engine().handle(conversationId)).rejects.toThrow(/boom/);
    expect(events.at(-1)).toMatchObject({ type: 'typing', typing: false });
    expect(await lock.acquire(`reply:${conversationId}`)).not.toBeNull();
    await engine().reportFailure(conversationId, new Error('供應商回應 500：boom'));
    const [sys] = await db.select().from(messages).where(eq(messages.senderType, 'system'));
    expect(sys!.meta).toEqual({ systemKind: 'error' });
    const [u] = await db.select().from(usageLog);
    expect(u).toMatchObject({ ok: false });
  });
});
