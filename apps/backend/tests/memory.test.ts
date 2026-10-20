// 記憶與關係：真的 PostgreSQL（含 pgvector）+ 假的 LLM 與嵌入（TEST_DATABASE_URL 沒設定時略過）
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appSettingsSchema, preferencesSchema, type ServerEvent } from '@acc/shared';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.ts';
import { SecretBox } from '../src/crypto.ts';
import { createDb, runMigrations } from '../src/db/client.ts';
import { avatars, conversationMembers, conversations, llmProfiles, memories, messages, relationships } from '../src/db/schema.ts';
import type { FetchFn } from '../src/llm/index.ts';
import { MemoryLock } from '../src/lock.ts';
import { extractMemories } from '../src/memory/extract.ts';
import { reflect } from '../src/memory/reflect.ts';
import { addMemories, backfillEmbeddings, retrieveMemories } from '../src/memory/store.ts';
import { ReplyEngine } from '../src/reply/engine.ts';
import { savePreferences } from '../src/profile/service.ts';
import { getRelationship } from '../src/relationship/service.ts';
import { WsHub } from '../src/ws.ts';
import { FakeEmbedder } from './fixtures/embedder.ts';
import { SAMPLE_PERSONA } from './fixtures/persona.ts';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('記憶與關係', () => {
  const { db, pool } = createDb(url ?? '');
  const box = new SecretBox('test-secret-0123456789');
  let replies: string[];
  let prompts: any[];
  const fetchFn = (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    prompts.push(body);
    return new Response(JSON.stringify({ choices: [{ message: { content: replies.shift() ?? '{}' } }], usage: {} }));
  }) as unknown as FetchFn;
  const ctx = { db, box, fetchFn };
  let avatarId: string;
  let conversationId: string;
  let profileId: string;
  let settings: ReturnType<typeof appSettingsSchema.parse>;

  beforeAll(async () => {
    await runMigrations(db);
  });

  beforeEach(async () => {
    await db.execute(
      sql`truncate settings, llm_profiles, avatars, conversations, conversation_members, messages, usage_log, user_profile, memories, relationships, avatar_state cascade`,
    );
    replies = [];
    prompts = [];
    const [p] = await db
      .insert(llmProfiles)
      .values({ name: 't', provider: 'openai-compatible', baseUrl: 'http://llm.test/v1', model: 'm' })
      .returning();
    profileId = p!.id;
    settings = appSettingsSchema.parse({ utilityLlm: { profileId, params: {} } });
    const [a] = await db
      .insert(avatars)
      .values({ name: '小雨', bio: '咖啡店店長', persona: SAMPLE_PERSONA, llm: { profileId, params: {} } })
      .returning();
    const [c] = await db.insert(conversations).values({ type: 'dm' }).returning();
    await db.insert(conversationMembers).values({ conversationId: c!.id, avatarId: a!.id });
    avatarId = a!.id;
    conversationId = c!.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('記憶的儲存與檢索', () => {
    const items = [
      { content: '阿明說下週二要去面試，很緊張', importance: 7 },
      { content: '阿明喜歡爬山，上個月去了合歡山', importance: 5 },
      { content: '我們約好下次一起去喝咖啡', importance: 6 },
    ];

    it('有嵌入時依語意相關度排序', async () => {
      const embedder = new FakeEmbedder();
      await addMemories(db, embedder, items.map((m) => ({ ...m, avatarId, kind: 'event' as const })));
      const top = await retrieveMemories(db, embedder, { avatarId, query: '面試準備得怎麼樣', limit: 2 });
      expect(top[0]!.content).toContain('面試');
      expect(top).toHaveLength(2);
    });

    it('沒有嵌入時退回雙連詞比對', async () => {
      await addMemories(db, null, items.map((m) => ({ ...m, avatarId, kind: 'event' as const })));
      const top = await retrieveMemories(db, null, { avatarId, query: '你最近還有去爬山嗎', limit: 1 });
      expect(top[0]!.content).toContain('爬山');
    });

    it('補上缺少的向量；換模型時重新嵌入', async () => {
      await addMemories(db, null, items.map((m) => ({ ...m, avatarId, kind: 'event' as const })));
      expect(await backfillEmbeddings(db, new FakeEmbedder('a'), avatarId)).toBe(3);
      expect(await backfillEmbeddings(db, new FakeEmbedder('a'), avatarId)).toBe(0);
      expect(await backfillEmbeddings(db, new FakeEmbedder('b'), avatarId)).toBe(3);
      const rows = await db.select().from(memories);
      expect(rows.every((r) => r.embeddingModel === 'b' && r.embedding?.length === 768)).toBe(true);
    });
  });

  describe('記憶萃取', () => {
    it('對話還在進行中就等；停下來之後才整理，而且不重複', async () => {
      await db.insert(messages).values([
        { conversationId, senderType: 'user', content: '我下週二要面試', createdAt: new Date('2026-10-19T10:00:00Z') },
        { conversationId, senderType: 'avatar', senderAvatarId: avatarId, content: '加油啦', createdAt: new Date('2026-10-19T10:00:30Z') },
      ]);
      expect(await extractMemories(ctx, settings, null, avatarId, conversationId, new Date('2026-10-19T10:05:00Z'))).toBe('later');
      expect(prompts).toHaveLength(0);

      await savePreferences(db, preferencesSchema.parse({ nickname: '阿明' }));
      replies = [
        JSON.stringify({
          memories: [{ content: '對方下週二要面試', importance: 7 }, { content: '我答應面試完請他喝咖啡', importance: 5, about: '我' }, { content: '' }],
        }),
      ];
      expect(await extractMemories(ctx, settings, null, avatarId, conversationId, new Date('2026-10-19T10:20:00Z'))).toBe('done');
      const rows = await db.select().from(memories);
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.importance === 7)).toMatchObject({ content: '對方下週二要面試', about: 'user', visibility: 'private', sourceConversationId: conversationId });
      expect(rows.find((r) => r.importance === 5)!.about).toBe('self');
      expect(prompts[0].messages.at(-1).content).toContain('名字是「阿明」');
      expect(prompts[0].messages.at(-1).content).toContain('對方：我下週二要面試');
      expect(prompts[0].messages.at(-1).content).toContain('我：加油啦');

      expect(await extractMemories(ctx, settings, null, avatarId, conversationId, new Date('2026-10-19T11:00:00Z'))).toBe('nothing');
    });
  });

  describe('整理印象', () => {
    it('新記憶夠多才整理，20 小時內不重複；force 可以立刻整理', async () => {
      // 用真實時間：記憶的建立時間由資料庫決定
      const now = new Date();
      const later = new Date(now.getTime() + 8 * 3600_000);
      await addMemories(db, null, [{ avatarId, kind: 'event', content: '只有一件事', importance: 5 }]);
      expect(await reflect(ctx, settings, null, avatarId, { now })).toBe(false);
      await addMemories(db, null, [
        { avatarId, kind: 'event', content: '第二件事', importance: 5 },
        { avatarId, kind: 'event', content: '第三件事', importance: 5 },
      ]);
      replies = ['他是個很穩重的人，我開始有點好奇他。'];
      expect(await reflect(ctx, settings, null, avatarId, { now })).toBe(true);
      const [imp] = await db.select().from(memories).where(eq(memories.kind, 'impression'));
      expect(imp!.content).toBe('他是個很穩重的人，我開始有點好奇他。');
      await addMemories(db, null, [{ avatarId, kind: 'event', content: '新的事', importance: 5 }]);
      expect(await reflect(ctx, settings, null, avatarId, { now: later })).toBe(false);
      replies = ['更新後的印象'];
      expect(await reflect(ctx, settings, null, avatarId, { now: later, force: true })).toBe(true);
    });

    it('整理印象時帶入對方的名字、你們的關係與自己的個性，不混入關於其他 avatar 的記憶', async () => {
      await savePreferences(db, preferencesSchema.parse({ nickname: '阿明' }));
      await addMemories(db, null, [
        { avatarId, kind: 'event', content: '對方早上喝了豆漿', importance: 5 },
        { avatarId, kind: 'event', content: '我答應對方週末烤蛋糕', importance: 6, about: 'self' },
        { avatarId, kind: 'event', content: 'Jerry 說他在設計公司上班', importance: 5, about: `avatar:${randomUUID()}` },
      ]);
      replies = ['對方是個早起也會亂的人。'];
      expect(await reflect(ctx, settings, null, avatarId, { force: true })).toBe(true);
      const content = prompts.at(-1).messages.at(-1).content as string;
      expect(content).toContain('對方的名字（希望被這樣稱呼）：阿明');
      expect(content).toContain(SAMPLE_PERSONA.relationship.withUser);
      expect(content).toContain(`你稱呼對方「${SAMPLE_PERSONA.relationship.callsUser}」`);
      expect(content).toContain(`個性：${SAMPLE_PERSONA.personality.traits.join('、')}`);
      expect(content).toContain('對方早上喝了豆漿');
      expect(content).toContain('我答應對方週末烤蛋糕');
      expect(content).not.toContain('Jerry');
      expect(content).not.toContain('他是個');
    });
  });

  describe('回覆後更新心情與關係', () => {
    function engine(events: ServerEvent[], replied: string[]) {
      return new ReplyEngine({
        db,
        box,
        events: { publish: async (e) => void events.push(e) },
        lock: new MemoryLock(),
        fetchFn,
        sleep: async () => {},
        random: () => 0.5,
        onReplied: async (a, c) => void replied.push(`${a}:${c}`),
      });
    }

    it('套用好感、信任、心情，並排程記憶萃取', async () => {
      await db.insert(messages).values({ conversationId, senderType: 'user', content: '我幫你帶了早餐' });
      replies = [
        JSON.stringify({
          messages: ['真假，謝啦'],
          mood: { label: '被暖到', valence: 3, energy: 1 },
          affinity_delta: 5,
          trust_delta: 1,
        }),
      ];
      const events: ServerEvent[] = [];
      const replied: string[] = [];
      await engine(events, replied).handle(conversationId);
      const rel = await getRelationship(db, avatarId);
      // 慢熱（warmUpSpeed: slow）：+5 先被限制成 +3，再 ×0.6 → +2
      expect(rel).toMatchObject({ stage: 'stranger', affinity: 2, trust: 11 });
      expect(replied).toEqual([`${avatarId}:${conversationId}`]);
      expect(events).toContainEqual({ type: 'avatar.state.changed', avatarId });
      const prompt = prompts[0].messages[0].content as string;
      expect(prompt).toContain('## 你們的關係：陌生');
    });

    it('數值不夠時，模型回報的告白事件不會讓關係變成戀人', async () => {
      await db.insert(relationships).values({ avatarId, target: 'user', stage: 'friend', affinity: 40, trust: 30 });
      await db.insert(messages).values({ conversationId, senderType: 'user', content: '我喜歡你' });
      replies = [JSON.stringify({ messages: ['欸…'], relationship_event: { type: 'confession_accepted', note: '他告白了' } })];
      await engine([], []).handle(conversationId);
      const rel = await getRelationship(db, avatarId);
      expect(rel.stage).toBe('friend');
      expect(rel.events.at(-1)).toMatchObject({ type: 'confession_accepted', note: '他告白了' });
    });

    it('相關的記憶會放進 prompt', async () => {
      await addMemories(db, null, [{ avatarId, kind: 'event', content: '對方下週二要去面試', importance: 8 }]);
      await db.insert(messages).values({ conversationId, senderType: 'user', content: '面試結束了！' });
      replies = [JSON.stringify({ messages: ['怎麼樣'] })];
      await engine([], []).handle(conversationId);
      expect(prompts[0].messages[0].content).toContain('對方下週二要去面試');
    });
  });

  describe('狀態 API', () => {
    it('建立時設定初始關係、查詢狀態、刪除記憶、重設關係', async () => {
      const app = await buildApp({
        db,
        box,
        events: { publish: async () => {} },
        jobs: { add: async () => {} },
        hub: new WsHub(),
        mediaDir: mkdtempSync(path.join(tmpdir(), 'acc-media-')),
        fetchFn,
      });
      const created = (
        await app.inject({ method: 'POST', url: '/api/avatars', payload: { name: '阿哲', initialStage: 'friend' } })
      ).json();
      let state = (await app.inject({ url: `/api/avatars/${created.id}/state` })).json();
      expect(state.relationship).toMatchObject({ stage: 'friend', affinity: 35, trust: 35, events: [] });
      expect(state.mood).toEqual({ label: '平常', valence: 0, energy: 0 });

      const [m] = await addMemories(db, null, [{ avatarId: created.id, kind: 'event', content: '要忘掉的事', importance: 3 }]);
      state = (await app.inject({ url: `/api/avatars/${created.id}/state` })).json();
      expect(state.memories.map((x: { content: string }) => x.content)).toEqual(['要忘掉的事']);
      expect((await app.inject({ method: 'DELETE', url: `/api/avatars/${created.id}/memories/${m!.id}` })).statusCode).toBe(204);
      state = (await app.inject({ url: `/api/avatars/${created.id}/state` })).json();
      expect(state.memories).toEqual([]);

      await app.inject({ method: 'POST', url: `/api/avatars/${created.id}/relationship/reset`, payload: { stage: 'close' } });
      state = (await app.inject({ url: `/api/avatars/${created.id}/state` })).json();
      expect(state.relationship).toMatchObject({ stage: 'close', affinity: 60 });
      await app.close();
    });
  });
});
