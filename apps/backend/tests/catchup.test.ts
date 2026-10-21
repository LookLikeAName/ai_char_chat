// 補上停機期間的主動訊息（TEST_DATABASE_URL 沒設定時略過 DB 的部分）
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import { appSettingsSchema, type AppSettings } from '@acc/shared';
import { SecretBox } from '../src/crypto.ts';
import { createDb, runMigrations } from '../src/db/client.ts';
import { avatars, conversationMembers, conversations, llmProfiles, messages, systemState } from '../src/db/schema.ts';
import type { FetchFn } from '../src/llm/index.ts';
import { MemoryLock } from '../src/lock.ts';
import { CATCH_UP_MAX_MS, catchUpProactive, catchUpWindow, lastWorkerSeen, markWorkerSeen } from '../src/proactive/catchUp.ts';
import { saveSettings } from '../src/services/settings.ts';
import { SAMPLE_PERSONA } from './fixtures/persona.ts';

// 2026-10-19 是週一；台北 = UTC+8。SAMPLE_PERSONA 平日 09:00–19:00 顧店（忙碌）、00:30–07:30 睡覺
const taipei = (hhmm: string, day = 19) => new Date(`2026-10-${String(day).padStart(2, '0')}T${hhmm}:00+08:00`);

describe('catchUpWindow', () => {
  const settings = appSettingsSchema.parse({});
  const now = taipei('12:00');
  it('第一次啟動、停機太短、關掉時不補', () => {
    expect(catchUpWindow(settings, null, now)).toBeNull();
    expect(catchUpWindow(settings, new Date(now.getTime() - 10 * 60_000), now)).toBeNull();
    expect(catchUpWindow(appSettingsSchema.parse({ proactive: { enabled: true, dailyLimit: 3, catchUp: false } }), taipei('08:00'), now)).toBeNull();
    expect(catchUpWindow(appSettingsSchema.parse({ proactive: { enabled: false, dailyLimit: 3 } }), taipei('08:00'), now)).toBeNull();
  });
  it('最多補最近 48 小時', () => {
    expect(catchUpWindow(settings, taipei('08:00'), now)).toEqual({ from: taipei('08:00'), to: now });
    expect(catchUpWindow(settings, taipei('08:00', 10), now)!.from).toEqual(new Date(now.getTime() - CATCH_UP_MAX_MS));
  });
});

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('補上停機期間的主動訊息', () => {
  const { db, pool } = createDb(url ?? '');
  const box = new SecretBox('test-secret-0123456789');
  const published: { type: string }[] = [];
  let prompts: any[];
  const fetchFn = (async (_u: string, init: RequestInit) => {
    prompts.push(JSON.parse(init.body as string));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ messages: ['在忙嗎', '剛剛店裡超多人'] }) } }], usage: {} }));
  }) as unknown as FetchFn;
  let avatarId: string;
  let conversationId: string;
  let settings: AppSettings;
  const deps = () => ({ db, box, fetchFn, lock: new MemoryLock(), events: { publish: async (e: { type: string }) => void published.push(e) } });

  async function addAvatar(createdAt: Date, persona = SAMPLE_PERSONA) {
    const [p] = await db.select().from(llmProfiles);
    const [a] = await db.insert(avatars).values({ name: '小雨', bio: '店長', persona, llm: { profileId: p!.id, params: {} }, createdAt }).returning();
    const [c] = await db.insert(conversations).values({ type: 'dm' }).returning();
    await db.insert(conversationMembers).values({ conversationId: c!.id, avatarId: a!.id, handledUpTo: taipei('22:01', 18), seenUpTo: taipei('22:01', 18) });
    avatarId = a!.id;
    conversationId = c!.id;
    // 前一天聊過，最後一則是 avatar 回的
    await db.insert(messages).values([
      { conversationId, senderType: 'user', content: '晚安', createdAt: taipei('22:00', 18) },
      { conversationId, senderType: 'avatar', senderAvatarId: avatarId, content: '晚安～', createdAt: taipei('22:01', 18) },
    ]);
  }

  beforeAll(async () => {
    await runMigrations(db);
  });

  beforeEach(async () => {
    prompts = [];
    published.length = 0;
    await db.execute(
      sql`truncate settings, llm_profiles, avatars, conversations, conversation_members, messages, usage_log, user_profile, memories, relationships, avatar_state, life_logs, system_state cascade`,
    );
    await db.insert(llmProfiles).values({ name: 't', provider: 'openai-compatible', baseUrl: 'http://llm.test/v1', model: 'm' });
    settings = appSettingsSchema.parse({ timezone: 'Asia/Taipei' });
    await saveSettings(db, settings);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('照當時的情境產生訊息，時間標成那個時間點；上一則沒被回就不再追', async () => {
    await addAvatar(taipei('10:00', 1));
    const r = await catchUpProactive(deps(), settings, { from: taipei('09:00'), to: taipei('21:00') }, { random: () => 0 });
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.at).toEqual(taipei('09:15'));

    const rows = await db.select().from(messages).where(and(eq(messages.conversationId, conversationId), eq(messages.senderType, 'avatar'))).orderBy(asc(messages.createdAt));
    const backfilled = rows.slice(1);
    expect(backfilled.map((m) => m.content)).toEqual(['在忙嗎', '剛剛店裡超多人']);
    expect(backfilled.every((m) => m.meta.proactive)).toBe(true);
    // 第一則在 09:15 之後打完字送出，兩則之間有間隔，都在停機的期間內
    expect(backfilled[0]!.createdAt.getTime()).toBeGreaterThan(taipei('09:15').getTime());
    expect(backfilled[1]!.createdAt.getTime()).toBeGreaterThan(backfilled[0]!.createdAt.getTime());
    expect(backfilled[1]!.createdAt.getTime()).toBeLessThan(taipei('09:20').getTime());
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
    expect(conv!.lastMessageAt!.getTime()).toBe(backfilled[1]!.createdAt.getTime());

    // prompt 用的是當時的時間與作息
    const system = prompts[0].messages[0].content as string;
    expect(system).toContain('10月19日 星期一 09:15');
    expect(system).toContain('你現在大概在：顧店（忙碌）');
    // 過去的訊息不顯示「輸入中」
    expect(published.some((e) => e.type === 'typing')).toBe(false);
    expect(published.some((e) => e.type === 'message.created')).toBe(true);
    const [state] = await db.select().from(systemState);
    expect(state!.catchUp).toMatchObject({ sent: 1 });
  });

  it('勿擾時段、睡覺的時間不補；那時候還不存在的 avatar 也不會傳', async () => {
    await addAvatar(taipei('10:00', 1));
    const night = await catchUpProactive(deps(), settings, { from: taipei('01:00'), to: taipei('07:45') }, { random: () => 0 });
    expect(night.sent).toHaveLength(0);
    expect(night.ticks).toBeGreaterThan(20);

    await db.execute(sql`truncate avatars, conversations, conversation_members, messages cascade`);
    await addAvatar(taipei('20:00'));
    const before = await catchUpProactive(deps(), settings, { from: taipei('09:00'), to: taipei('19:00') }, { random: () => 0 });
    expect(before.sent).toHaveLength(0);
    expect(prompts).toHaveLength(0);
  });

  it('記錄 worker 最後還在運作的時間', async () => {
    expect(await lastWorkerSeen(db)).toBeNull();
    await markWorkerSeen(db, taipei('09:00'));
    await markWorkerSeen(db, taipei('09:01'));
    expect(await lastWorkerSeen(db)).toEqual(taipei('09:01'));
  });
});
