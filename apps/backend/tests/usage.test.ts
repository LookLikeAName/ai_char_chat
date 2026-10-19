// 用量：每日上限（全域、每個 avatar）、費用估算、統計（TEST_DATABASE_URL 沒設定時略過）
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { appSettingsSchema } from '@acc/shared';
import { SecretBox } from '../src/crypto.ts';
import { createDb, runMigrations } from '../src/db/client.ts';
import { avatars, conversationMembers, conversations, llmProfiles, messages, usageLog } from '../src/db/schema.ts';
import type { FetchFn } from '../src/llm/index.ts';
import { MemoryLock } from '../src/lock.ts';
import { ReplyEngine } from '../src/reply/engine.ts';
import { callWithBinding } from '../src/services/llmCall.ts';
import { saveSettings } from '../src/services/settings.ts';
import { localDayStart, QuotaError, usageSummary } from '../src/services/usage.ts';

describe('localDayStart', () => {
  it('依時區算出當地的 0 點', () => {
    // 台北 10/19 20:00 → 當天 0 點是 UTC 10/18 16:00
    expect(localDayStart(new Date('2026-10-19T12:00:00Z'), 'Asia/Taipei').toISOString()).toBe('2026-10-18T16:00:00.000Z');
    // 台北 10/20 00:30 → 已經是隔天
    expect(localDayStart(new Date('2026-10-19T16:30:00Z'), 'Asia/Taipei').toISOString()).toBe('2026-10-19T16:00:00.000Z');
    expect(localDayStart(new Date('2026-10-19T03:00:00Z'), 'America/Los_Angeles').toISOString()).toBe('2026-10-18T07:00:00.000Z');
  });
});

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('每日上限與統計', () => {
  const { db, pool } = createDb(url ?? '');
  const box = new SecretBox('test-secret-0123456789');
  let calls: number;
  const fetchFn = (async () => {
    calls++;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ inner_thought: '嗯', messages: ['嗨嗨'] }) } }],
        usage: { prompt_tokens: 1000, completion_tokens: 200 },
      }),
    );
  }) as unknown as FetchFn;
  let profileId: string;
  let avatarId: string;
  let conversationId: string;

  const engine = () =>
    new ReplyEngine({ db, box, events: { publish: async () => {} }, lock: new MemoryLock(), fetchFn, sleep: async () => {}, random: () => 0.5 });

  const setLimit = (dailyTokenLimit: number) => saveSettings(db, appSettingsSchema.parse({ dailyTokenLimit }));
  const used = (tokens: number, avatar: string | null = avatarId, createdAt = new Date()) =>
    db.insert(usageLog).values({ purpose: 'reply', avatarId: avatar, model: 'm', inputTokens: tokens, outputTokens: 0, ok: true, createdAt });

  async function transcript() {
    const rows = await db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt), asc(messages.seq));
    return rows.map((r) => `${r.senderType}:${r.content.slice(0, 12)}`);
  }

  beforeAll(async () => {
    await runMigrations(db);
  });

  beforeEach(async () => {
    await db.execute(sql`truncate settings, llm_profiles, avatars, conversations, conversation_members, messages, usage_log, user_profile cascade`);
    calls = 0;
    const [p] = await db
      .insert(llmProfiles)
      .values({ name: 't', provider: 'openai-compatible', baseUrl: 'http://llm.test/v1', model: 'm', pricing: { input: 2, output: 10 } })
      .returning();
    profileId = p!.id;
    const [a] = await db.insert(avatars).values({ name: '小雨', llm: { profileId, params: {} } }).returning();
    avatarId = a!.id;
    const [c] = await db.insert(conversations).values({ type: 'dm' }).returning();
    await db.insert(conversationMembers).values({ conversationId: c!.id, avatarId });
    conversationId = c!.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('依設定檔的價格記下費用', async () => {
    await callWithBinding({ db, box, fetchFn }, { profileId, params: {} }, { system: 's', messages: [{ role: 'user', content: 'u' }] }, { purpose: 'reply', avatarId });
    const [row] = await db.select().from(usageLog);
    // 1000 × $2/M + 200 × $10/M
    expect(row!.costUsd).toBeCloseTo(0.004, 6);
  });

  it('超過全域上限：不呼叫 LLM、留一則可以重試的提示（不重複留）；調高上限後就會回', async () => {
    await setLimit(500);
    await used(600, null);
    await db.insert(messages).values({ conversationId, senderType: 'user', content: '嗨' });
    expect(await engine().handle(conversationId)).toBe('done');
    expect(await engine().handle(conversationId, { force: true })).toBe('done');
    expect(calls).toBe(0);
    const notices = await db.select().from(messages).where(eq(messages.senderType, 'system'));
    expect(notices).toHaveLength(1);
    expect(notices[0]!.meta).toMatchObject({ systemKind: 'error' });
    expect(notices[0]!.content).toContain('今天的總用量已達上限');

    await setLimit(0);
    expect(await engine().handle(conversationId, { force: true })).toBe('done');
    expect(calls).toBe(1);
    expect((await transcript()).at(-1)).toBe('avatar:嗨嗨');
  });

  it('avatar 自己的上限只算它的用量；昨天的不算', async () => {
    await db.update(avatars).set({ dailyTokenLimit: 1000 }).where(eq(avatars.id, avatarId));
    await used(5000, null); // 系統工具模型的用量不算在它頭上
    await used(5000, avatarId, new Date(Date.now() - 2 * 86_400_000));
    await db.insert(messages).values({ conversationId, senderType: 'user', content: '嗨' });
    await engine().handle(conversationId);
    expect(calls).toBe(1);

    await used(1000);
    await db.insert(messages).values({ conversationId, senderType: 'user', content: '在嗎' });
    await engine().handle(conversationId, { force: true });
    expect(calls).toBe(1);
    expect((await transcript()).at(-1)).toContain('system:小雨 今天的用量');
  });

  it('上限擋住背景呼叫，但玩家自己按的功能（補完角色）不受限', async () => {
    await setLimit(10);
    await used(100, null);
    const req = { system: 's', messages: [{ role: 'user' as const, content: 'u' }] };
    await expect(callWithBinding({ db, box, fetchFn }, { profileId, params: {} }, req, { purpose: 'memory.extract', avatarId })).rejects.toBeInstanceOf(QuotaError);
    await expect(callWithBinding({ db, box, fetchFn }, { profileId, params: {} }, req, { purpose: 'persona.generate' })).resolves.toBeTruthy();
  });

  it('主動發話在超過上限時略過', async () => {
    await db.update(avatars).set({ dailyTokenLimit: 100 }).where(eq(avatars.id, avatarId));
    await used(100);
    expect(await engine().handleProactive(conversationId)).toBe('skipped');
    expect(calls).toBe(0);
    expect(await transcript()).toEqual([]);
  });

  it('統計：每天都有一列（沒用量補 0），依 avatar 分組並帶上限', async () => {
    await db.update(avatars).set({ dailyTokenLimit: 9000 }).where(eq(avatars.id, avatarId));
    await setLimit(50_000);
    await used(300);
    await used(200, null);
    await used(700, avatarId, new Date(Date.now() - 2 * 86_400_000));
    const s = await usageSummary(db, 7);
    expect(s.daily).toHaveLength(7);
    expect(s.daily.at(-1)!.inputTokens).toBe(500);
    expect(s.daily.reduce((n, d) => n + d.inputTokens, 0)).toBe(1200);
    expect(s.today).toMatchObject({ inputTokens: 500, calls: 2, limit: 50_000 });
    const mine = s.byAvatar.find((r) => r.avatarId === avatarId)!;
    expect(mine).toMatchObject({ inputTokens: 1000, todayTokens: 300, limit: 9000 });
    expect(s.byAvatar.find((r) => r.avatarId === null)!.inputTokens).toBe(200);
  });
});
