// 擬真時間：排程、時間未到、主動發話、每 15 分鐘的檢查（TEST_DATABASE_URL 沒設定時略過）
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { appSettingsSchema, type AppSettings } from '@acc/shared';
import { SecretBox } from '../src/crypto.ts';
import { createDb, runMigrations } from '../src/db/client.ts';
import { avatars, avatarState, conversationMembers, conversations, lifeLogs, llmProfiles, messages } from '../src/db/schema.ts';
import type { AgentJob } from '../src/jobs.ts';
import type { FetchFn } from '../src/llm/index.ts';
import { MemoryLock } from '../src/lock.ts';
import { proactiveTick } from '../src/proactive/tick.ts';
import { ReplyEngine } from '../src/reply/engine.ts';
import { scheduleReply } from '../src/reply/planner.ts';
import { saveSettings } from '../src/services/settings.ts';
import { SAMPLE_PERSONA } from './fixtures/persona.ts';

const url = process.env.TEST_DATABASE_URL;
// 2026-10-19 是週一；台北 = UTC+8。SAMPLE_PERSONA 平日 09:00–19:00 顧店（忙碌）、00:30–07:30 睡覺
const taipei = (hhmm: string, day = 19) => new Date(`2026-10-${day}T${hhmm}:00+08:00`);

describe.skipIf(!url)('擬真時間', () => {
  const { db, pool } = createDb(url ?? '');
  const box = new SecretBox('test-secret-0123456789');
  let prompts: any[];
  let respond: (body: any) => string;
  const fetchFn = (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    prompts.push(body);
    return new Response(JSON.stringify({ choices: [{ message: { content: respond(body) } }], usage: {} }));
  }) as unknown as FetchFn;
  let avatarId: string;
  let conversationId: string;
  let settings: AppSettings;
  let jobs: { job: AgentJob; delayMs?: number }[];
  const queue = { add: async (job: AgentJob, opts?: { delayMs?: number }) => void jobs.push({ job, delayMs: opts?.delayMs }) };

  async function setup(extra: Partial<AppSettings> = {}) {
    settings = appSettingsSchema.parse({ timezone: 'Asia/Taipei', ...extra });
    await saveSettings(db, settings);
  }

  async function say(content: string, createdAt: Date, senderType: 'user' | 'avatar' = 'user', meta = {}) {
    await db.insert(messages).values({
      conversationId,
      senderType,
      senderAvatarId: senderType === 'avatar' ? avatarId : null,
      content,
      createdAt,
      meta,
    });
  }

  beforeAll(async () => {
    await runMigrations(db);
  });

  beforeEach(async () => {
    await db.execute(
      sql`truncate settings, llm_profiles, avatars, conversations, conversation_members, messages, usage_log, user_profile, memories, relationships, avatar_state, life_logs cascade`,
    );
    prompts = [];
    jobs = [];
    respond = () => JSON.stringify({ messages: ['嗯'] });
    const [p] = await db
      .insert(llmProfiles)
      .values({ name: 't', provider: 'openai-compatible', baseUrl: 'http://llm.test/v1', model: 'm' })
      .returning();
    const [a] = await db
      .insert(avatars)
      .values({ name: '小雨', persona: SAMPLE_PERSONA, llm: { profileId: p!.id, params: {} } })
      .returning();
    const [c] = await db.insert(conversations).values({ type: 'dm' }).returning();
    await db.insert(conversationMembers).values({ conversationId: c!.id, avatarId: a!.id });
    avatarId = a!.id;
    conversationId = c!.id;
    await setup({ utilityLlm: { profileId: p!.id, params: {} } });
  });

  afterAll(async () => {
    await pool.end();
  });

  const member = async () => (await db.select().from(conversationMembers).where(eq(conversationMembers.conversationId, conversationId)))[0]!;

  describe('排程：什麼時候看到訊息', () => {
    it('忙碌時排得很晚；連續催促會提前；之後的普通訊息不會延後', async () => {
      const now = taipei('10:00');
      await say('嗨', now);
      const first = await scheduleReply(db, queue, conversationId, { now, random: () => 0.9 });
      expect(first!.reason).toBe('late');
      expect(first!.at.getTime() - now.getTime()).toBeGreaterThan(10 * 60_000);
      expect(jobs).toHaveLength(1);

      const t2 = new Date(now.getTime() + 60_000);
      await say('在嗎', t2);
      const second = await scheduleReply(db, queue, conversationId, { now: t2, random: () => 0.9 });
      expect(second!.reason).toBe('interrupted');
      expect(second!.at < first!.at).toBe(true);
      expect(jobs).toHaveLength(2);
      expect((await member()).replyReason).toBe('interrupted');

      const t3 = new Date(t2.getTime() + 30_000);
      await say('沒事啦', t3);
      const third = await scheduleReply(db, queue, conversationId, { now: t3, random: () => 0.9 });
      expect(third!.at.getTime()).toBe(second!.at.getTime());
      expect(jobs).toHaveLength(2);
    });

    it('剛聊過（avatar 5 分鐘內傳過訊息）就當作在線', async () => {
      const now = taipei('10:00');
      await say('我在顧店喔', new Date(now.getTime() - 60_000), 'avatar');
      await say('好喔', now);
      const plan = await scheduleReply(db, queue, conversationId, { now, random: () => 0.9 });
      expect(plan!.reason).toBe('normal');
      expect(plan!.at.getTime() - now.getTime()).toBeLessThan(3 * 60_000);
    });

    it('即時節奏時幾秒內就處理', async () => {
      await setup({ replyPacing: 'instant' });
      const now = taipei('03:00');
      await say('嗨', now);
      const plan = await scheduleReply(db, queue, conversationId, { now, random: () => 0.5 });
      expect(jobs[0]!.delayMs).toBeLessThan(3000);
      expect(plan!.reason).toBe('normal');
    });
  });

  describe('回覆引擎：時間未到不動作，回覆時知道當下的情境', () => {
    const engine = (now: Date) =>
      new ReplyEngine({ db, box, events: { publish: async () => {} }, lock: new MemoryLock(), fetchFn, sleep: async () => {}, random: () => 0.5, now: () => now });

    it('預計時間還沒到回傳 early；到了才回，並告訴 avatar 過了多久才看到', async () => {
      const sent = taipei('10:00');
      await say('嗨', sent);
      await db
        .update(conversationMembers)
        .set({ replyDueAt: taipei('11:30'), replyReason: 'late' })
        .where(eq(conversationMembers.conversationId, conversationId));
      expect(await engine(taipei('10:30')).handle(conversationId)).toBe('early');
      expect(prompts).toHaveLength(0);

      expect(await engine(taipei('11:30')).handle(conversationId)).toBe('done');
      const system = prompts[0].messages[0].content as string;
      expect(system).toContain('你剛剛在顧店，過了 2 小時才看到對方的訊息');
      expect((await member()).replyDueAt).toBeNull();
    });

    it('重試（force）忽略預計時間', async () => {
      await say('嗨', taipei('10:00'));
      await db
        .update(conversationMembers)
        .set({ replyDueAt: taipei('12:00'), replyReason: 'woken' })
        .where(eq(conversationMembers.conversationId, conversationId));
      expect(await engine(taipei('10:05')).handle(conversationId, { force: true })).toBe('done');
      expect(prompts[0].messages[0].content).toContain('被對方連續的訊息吵醒');
    });

    it('主動發話：送出標記為主動的訊息並累計次數；模型決定不說話時略過', async () => {
      const now = taipei('20:00');
      await say('晚安', taipei('08:00'), 'avatar');
      respond = () => JSON.stringify({ messages: ['欸你吃飯沒', '我今天被客人氣死'] });
      expect(await engine(now).handleProactive(conversationId)).toBe('sent');
      const rows = await db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt), asc(messages.seq));
      expect(rows.slice(1).map((r) => [r.content, r.meta.proactive])).toEqual([
        ['欸你吃飯沒', true],
        ['我今天被客人氣死', true],
      ]);
      const body = prompts[0];
      expect(body.messages[0].content).toContain('是你想主動傳訊息給對方');
      expect(body.messages.at(-1)).toMatchObject({ role: 'user' });
      expect(body.messages.at(-1).content).toContain('現在由你主動傳訊息');
      const [st] = await db.select().from(avatarState).where(eq(avatarState.avatarId, avatarId));
      expect(st).toMatchObject({ proactiveDate: '2026-10-19', proactiveCount: 1 });

      respond = () => JSON.stringify({ messages: [] });
      expect(await engine(now).handleProactive(conversationId)).toBe('skipped');
    });

    it('玩家有還沒回的訊息時，不主動發話', async () => {
      await say('在嗎', taipei('20:00'));
      expect(await engine(taipei('20:05')).handleProactive(conversationId)).toBe('skipped');
      expect(prompts).toHaveLength(0);
    });
  });

  describe('每 15 分鐘的檢查', () => {
    const ctx = { db, box, fetchFn };
    const enqueued: AgentJob[] = [];
    const enqueue = async (j: AgentJob) => void enqueued.push(j);
    beforeEach(() => {
      enqueued.length = 0;
      respond = (body) =>
        String(body.messages[0]?.content).includes('安排生活')
          ? JSON.stringify({ events: [{ time: '08:10', text: '開店前喝了一杯淺焙' }, { time: '25:00', text: '不合法' }, { time: '13:00', text: '午餐吃便當' }] })
          : JSON.stringify({ messages: ['嗨'] });
    });

    it('產生今天的生活日誌（只產生一次），機率命中時排程主動訊息', async () => {
      await say('晚安', taipei('08:00'), 'avatar');
      const now = taipei('20:00');
      const d = await proactiveTick(ctx, settings, enqueue, { now, random: () => 0 });
      expect(d).toEqual([expect.objectContaining({ avatarId, action: 'enqueued' })]);
      expect(enqueued).toEqual([{ kind: 'proactive', avatarId, conversationId }]);
      const [log] = await db.select().from(lifeLogs);
      expect(log).toMatchObject({ date: '2026-10-19' });
      expect(log!.events.map((e) => e.time)).toEqual(['08:10', '13:00']);
      await proactiveTick(ctx, settings, enqueue, { now, random: () => 0 });
      expect(prompts.filter((p) => String(p.messages[0]?.content).includes('安排生活'))).toHaveLength(1);
    });

    it('勿擾時段、次數用完、上一則主動訊息沒被回、玩家的訊息還沒回時都不傳', async () => {
      const reasons = async (now: Date) => (await proactiveTick(ctx, settings, enqueue, { now, random: () => 0 }))[0]!.reason;
      await say('晚安', taipei('08:00'), 'avatar');
      expect(await reasons(taipei('02:00', 20))).toBe('勿擾時段');

      await db.insert(avatarState).values({ avatarId, mood: { label: '平常', valence: 0, energy: 0 }, proactiveDate: '2026-10-19', proactiveCount: 3 });
      expect(await reasons(taipei('20:00'))).toBe('今天的次數用完了');
      await db.delete(avatarState);

      await say('欸', taipei('18:00'), 'avatar', { proactive: true });
      expect(await reasons(taipei('20:00'))).toBe('上一則主動訊息還沒被回');

      await say('剛下班', taipei('19:00'));
      expect(await reasons(taipei('20:00'))).toBe('玩家的訊息還沒回');
      expect(enqueued).toEqual([]);
    });
  });
});
