// 匯出／匯入 avatar（TEST_DATABASE_URL 沒設定時略過）
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AvatarDto, ImportResultDto, TransferFile } from '@acc/shared';
import { buildApp } from '../src/app.ts';
import { SecretBox } from '../src/crypto.ts';
import { createDb, runMigrations } from '../src/db/client.ts';
import { avatars, conversationMembers, llmProfiles, memories, messages, relationships } from '../src/db/schema.ts';
import { addMemories } from '../src/memory/store.ts';
import { WsHub } from '../src/ws.ts';
import { SAMPLE_PERSONA } from './fixtures/persona.ts';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('匯出／匯入', () => {
  const { db, pool } = createDb(url ?? '');
  const mediaDir = mkdtempSync(path.join(tmpdir(), 'acc-media-'));
  let app: FastifyInstance;
  let profileId: string;
  let source: AvatarDto;
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

  beforeAll(async () => {
    await runMigrations(db);
    app = await buildApp({
      db,
      box: new SecretBox('test-secret-0123456789'),
      events: { publish: async () => {} },
      jobs: { add: async () => {} },
      hub: new WsHub(),
      mediaDir,
    });
  });

  beforeEach(async () => {
    await db.execute(sql`truncate settings, llm_profiles, avatars, conversations, conversation_members, messages, memories, relationships, user_profile cascade`);
    const [p] = await db.insert(llmProfiles).values({ name: 'p', provider: 'openai', model: 'm' }).returning();
    profileId = p!.id;
    const res = await app.inject({
      method: 'POST',
      url: '/api/avatars',
      payload: { name: '小雨', bio: '咖啡店店長', persona: SAMPLE_PERSONA, llm: { profileId, params: { temperature: 1.3 } }, dailyTokenLimit: 5000, initialStage: 'friend' },
    });
    source = res.json();
    const form = new FormData();
    form.append('file', new Blob([PNG], { type: 'image/png' }), 'a.png');
    const body = new Response(form);
    await app.inject({
      method: 'POST',
      url: `/api/avatars/${source.id}/image`,
      headers: Object.fromEntries(body.headers),
      payload: Buffer.from(await body.arrayBuffer()),
    });
    await db.insert(messages).values([
      { conversationId: source.dmConversationId, senderType: 'user', content: '嗨', createdAt: new Date('2026-10-01T10:00:00Z') },
      { conversationId: source.dmConversationId, senderType: 'avatar', senderAvatarId: source.id, content: '嗨嗨', createdAt: new Date('2026-10-01T10:00:05Z') },
      { conversationId: source.dmConversationId, senderType: 'system', content: '系統訊息', createdAt: new Date('2026-10-01T10:00:06Z') },
      {
        conversationId: source.dmConversationId,
        senderType: 'avatar',
        senderAvatarId: source.id,
        content: '',
        meta: { image: { path: 'photos/x.png', mime: 'image/png', width: 1, height: 1, description: '一杯拿鐵' } },
        createdAt: new Date('2026-10-01T10:00:07Z'),
      },
    ]);
    await addMemories(db, null, [
      { avatarId: source.id, kind: 'event', content: '對方在準備面試', importance: 8 },
      { avatarId: source.id, kind: 'event', content: '阿哲很愛吐槽', importance: 4, about: 'avatar:x' },
    ]);
  });

  afterAll(async () => {
    await app?.close();
    await pool.end();
    rmSync(mediaDir, { recursive: true, force: true });
  });

  const exportOne = async (query = '') => {
    const res = await app.inject({ method: 'GET', url: `/api/avatars/${source.id}/export${query}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain(encodeURIComponent('小雨'));
    return res.json() as TransferFile;
  };

  it('預設只匯出設定與頭像，不含 API key、記憶、聊天紀錄', async () => {
    const file = await exportOne();
    const [card] = file.avatars;
    expect(card).toMatchObject({ name: '小雨', bio: '咖啡店店長', llmParams: { temperature: 1.3 }, dailyTokenLimit: 5000 });
    expect(Buffer.from(card!.image!.data, 'base64').equals(PNG)).toBe(true);
    expect(card!.memories).toBeUndefined();
    expect(card!.messages).toBeUndefined();
    expect(JSON.stringify(file)).not.toContain(profileId);
    expect(card!.photo).toMatchObject({ appears: 'self', reference: 'avatar' });
  });

  it('帶記憶與紀錄匯出，再匯入成新的 avatar：綁定選的設定檔、關係與記憶都在、紀錄算已讀已回', async () => {
    const file = await exportOne('?memories=true&history=true');
    const [card] = file.avatars;
    expect(card!.memories!.map((m) => m.content)).toEqual(['對方在準備面試']);
    // 圖片不匯出，變成文字標記
    expect(card!.messages!.map((m) => m.content)).toEqual(['嗨', '嗨嗨', '［照片：一杯拿鐵］']);
    expect(card!.relationship!.stage).toBe('friend');

    const res = await app.inject({
      method: 'POST',
      url: '/api/avatars/import',
      payload: { file, profileId, include: { memories: true, history: true } },
    });
    expect(res.statusCode).toBe(200);
    const { avatars: [imported] } = res.json() as ImportResultDto;
    expect(imported).toMatchObject({ name: '小雨', memories: 1, messages: 3 });
    expect(imported!.id).not.toBe(source.id);

    const [row] = await db.select().from(avatars).where(eq(avatars.id, imported!.id));
    expect(row!.llm).toEqual({ profileId, params: { temperature: 1.3 } });
    expect(row!.persona).toEqual(source.persona);
    expect(readFileSync(path.join(mediaDir, row!.imagePath!)).equals(PNG)).toBe(true);
    const [rel] = await db.select().from(relationships).where(and(eq(relationships.avatarId, imported!.id), eq(relationships.target, 'user')));
    expect(rel!.stage).toBe('friend');
    expect((await db.select().from(memories).where(eq(memories.avatarId, imported!.id))).map((m) => m.content)).toEqual(['對方在準備面試']);
    const msgs = await db.select().from(messages).where(eq(messages.conversationId, imported!.dmConversationId)).orderBy(asc(messages.createdAt));
    expect(msgs.map((m) => [m.senderType, m.content, m.senderAvatarId === imported!.id])).toEqual([
      ['user', '嗨', false],
      ['avatar', '嗨嗨', true],
      ['avatar', '［照片：一杯拿鐵］', true],
    ]);
    const [member] = await db.select().from(conversationMembers).where(eq(conversationMembers.conversationId, imported!.dmConversationId));
    expect(member!.handledUpTo?.toISOString()).toBe('2026-10-01T10:00:07.000Z');
    const convs = (await app.inject({ method: 'GET', url: '/api/conversations' })).json();
    expect(convs.find((c: { id: string }) => c.id === imported!.dmConversationId).unreadCount).toBe(0);
  });

  it('匯入時可以不帶檔案裡的記憶與紀錄，也可以先不綁 LLM', async () => {
    const file = await exportOne('?memories=true&history=true');
    const res = await app.inject({ method: 'POST', url: '/api/avatars/import', payload: { file, profileId: null, include: { memories: false, history: false } } });
    const { avatars: [imported] } = res.json() as ImportResultDto;
    expect(imported).toMatchObject({ memories: 0, messages: 0 });
    const [row] = await db.select().from(avatars).where(eq(avatars.id, imported!.id));
    expect(row!.llm).toBeNull();
    const [rel] = await db.select().from(relationships).where(eq(relationships.avatarId, imported!.id));
    expect(rel!.stage).toBe('stranger');
  });

  it('全部匯出；格式不對或人格設定不完整時整批拒絕', async () => {
    const all = (await app.inject({ method: 'GET', url: '/api/avatars/export' })).json() as TransferFile;
    expect(all.avatars).toHaveLength(1);

    const bad = await app.inject({ method: 'POST', url: '/api/avatars/import', payload: { file: { format: 'x' }, profileId: null, include: { memories: true, history: true } } });
    expect(bad.statusCode).toBe(400);

    const broken = { ...all, avatars: [all.avatars[0]!, { ...all.avatars[0]!, name: '壞掉', persona: { basic: { age: 20 } } }] };
    const res = await app.inject({ method: 'POST', url: '/api/avatars/import', payload: { file: broken, profileId: null, include: { memories: false, history: false } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('第 2 個（壞掉）');
    expect(await db.select().from(avatars)).toHaveLength(1);
  });
});
