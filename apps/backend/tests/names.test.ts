// 本名與顯示名稱（TEST_DATABASE_URL 沒設定時略過 DB 的部分）
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { shownName, type AvatarDto, type ConversationDto, type TransferFile } from '@acc/shared';
import { buildApp } from '../src/app.ts';
import { SecretBox } from '../src/crypto.ts';
import { createDb, runMigrations } from '../src/db/client.ts';
import { buildReplyPrompt, buildSystemPrompt } from '../src/reply/prompt.ts';
import { WsHub } from '../src/ws.ts';

const base = {
  settings: { timezone: 'Asia/Taipei', adultContent: false },
  history: [],
  now: new Date('2026-10-19T03:00:00Z'),
};

describe('shownName', () => {
  it('有顯示名稱就用它，空的用本名', () => {
    expect(shownName({ name: '林小雨', displayName: 'Rain' })).toBe('Rain');
    expect(shownName({ name: '林小雨', displayName: '  ' })).toBe('林小雨');
    expect(shownName({ name: '林小雨' })).toBe('林小雨');
  });
});

describe('prompt 裡的本名與顯示名稱', () => {
  it('自己：知道本名與顯示名稱，要不要說本名自己決定', () => {
    const prompt = buildSystemPrompt({ ...base, avatar: { name: '林小雨', displayName: 'Rain', bio: '', persona: {} } });
    expect(prompt).toContain('你是「林小雨」（通訊軟體上的顯示名稱是「Rain」）');
    expect(prompt).toContain('還不熟的人不一定知道你的本名「林小雨」');
    const plain = buildSystemPrompt({ ...base, avatar: { name: '林小雨', displayName: '', bio: '', persona: {} } });
    expect(plain).not.toContain('顯示名稱');
  });

  it('群組：不認識的成員只看得到顯示名稱，認識的也知道本名；紀錄用顯示名稱標示', () => {
    const group = {
      conversationId: 'g',
      title: '週末團',
      selfId: 'self',
      members: [
        { id: 'a', name: '陳哲宇', displayName: 'Jerry', bio: '工程師', relationship: { stage: 'stranger' as const, affinity: 0, trust: 10 } },
        { id: 'b', name: '王美美', displayName: '美美der', bio: '店員', relationship: { stage: 'friend' as const, affinity: 40, trust: 35 } },
      ],
      userName: '阿明',
      discretion: 60,
    };
    const { system, messages } = buildReplyPrompt({
      ...base,
      avatar: { name: '林小雨', bio: '', persona: {} },
      group,
      history: [
        { senderType: 'avatar', senderAvatarId: 'a', content: '大家好', createdAt: new Date('2026-10-19T02:58:00Z') },
        { senderType: 'user', content: '嗨', createdAt: new Date('2026-10-19T02:59:00Z') },
      ],
    });
    expect(system).toContain('還有「Jerry」、「美美der」');
    expect(system).toContain('- Jerry：（還不認識，只知道名字）');
    expect(system).not.toContain('陳哲宇');
    expect(system).toContain('- 美美der（本名王美美）：店員');
    expect(system).toMatch(/你和Jerry還不認識/);
    expect(JSON.stringify(messages)).toContain('Jerry');
  });

  it('認識的人：列出本名與顯示名稱', () => {
    const prompt = buildSystemPrompt({
      ...base,
      avatar: { name: '林小雨', bio: '', persona: {} },
      acquaintances: [{ name: '陳哲宇', displayName: 'Jerry', relation: '同事', bio: '' }],
    });
    expect(prompt).toContain('- 陳哲宇（顯示名稱：Jerry）：同事');
  });
});

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('顯示名稱 API', () => {
  const { db, pool } = createDb(url ?? '');
  const mediaDir = mkdtempSync(path.join(tmpdir(), 'acc-media-'));
  let app: FastifyInstance;

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
    await db.execute(sql`truncate settings, llm_profiles, avatars, conversations, conversation_members, messages, relationships, avatar_links cascade`);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    rmSync(mediaDir, { recursive: true, force: true });
  });

  it('建立、更新（省略時不變）、對話列表用顯示名稱、匯出入保留', async () => {
    const created = (await app.inject({ method: 'POST', url: '/api/avatars', payload: { name: '林小雨', displayName: 'Rain', bio: '' } })).json() as AvatarDto;
    expect(created).toMatchObject({ name: '林小雨', displayName: 'Rain' });

    const put = (payload: Record<string, unknown>) =>
      app.inject({ method: 'PUT', url: `/api/avatars/${created.id}`, payload: { name: '林小雨', bio: '', ...payload } });
    expect((await put({})).json().displayName).toBe('Rain');
    expect((await put({ displayName: '小雨點' })).json().displayName).toBe('小雨點');

    const convs = (await app.inject({ url: '/api/conversations' })).json() as ConversationDto[];
    expect(convs.find((c) => c.id === created.dmConversationId)!.title).toBe('小雨點');

    const file = (await app.inject({ url: `/api/avatars/${created.id}/export` })).json() as TransferFile;
    expect(file.avatars[0]!.displayName).toBe('小雨點');
    const imported = await app.inject({ method: 'POST', url: '/api/avatars/import', payload: { file, profileId: null, include: { memories: false, history: false } } });
    const id = imported.json().avatars[0].id;
    expect(((await app.inject({ url: `/api/avatars/${id}` })).json() as AvatarDto).displayName).toBe('小雨點');

    expect((await put({ displayName: '' })).json().displayName).toBe('');
  });
});
