// 相關的角色（TEST_DATABASE_URL 沒設定時略過 DB 的部分）
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { appSettingsSchema, type AvatarDto, type ImportResultDto, type TransferFile } from '@acc/shared';
import { buildApp } from '../src/app.ts';
import { SecretBox } from '../src/crypto.ts';
import { createDb, runMigrations } from '../src/db/client.ts';
import { avatarLinks, llmProfiles, relationships } from '../src/db/schema.ts';
import { checkPersona } from '../src/persona/check.ts';
import { generatePersona } from '../src/persona/generate.ts';
import { buildSystemPrompt } from '../src/reply/prompt.ts';
import { WsHub } from '../src/ws.ts';
import { SAMPLE_PERSONA } from './fixtures/persona.ts';

describe('prompt 裡的相關角色', () => {
  const base = {
    avatar: { name: '阿哲', bio: '設計師', persona: SAMPLE_PERSONA },
    settings: { timezone: 'Asia/Taipei', adultContent: false },
    history: [],
    now: new Date('2026-10-19T03:00:00Z'),
  };

  it('一對一：列出認識的人與關係，並提醒不知道他們和玩家聊了什麼', () => {
    const prompt = buildSystemPrompt({
      ...base,
      acquaintances: [{ name: '林小雨', relation: '同一間設計公司的同事，林小雨是阿哲的主管', bio: '設計總監', occupation: '設計總監', traits: ['嚴格', '護短'] }],
    });
    expect(prompt).toContain('## 你生活裡認識的人');
    expect(prompt).toContain('- 林小雨：同一間設計公司的同事，林小雨是阿哲的主管');
    expect(prompt).toContain('（設計總監；嚴格、護短）');
    expect(prompt).toContain('不要捏造他們跟對方說過的話');
  });

  it('群組：成員旁邊寫出關係，已經是成員的不重複列在認識的人', () => {
    const prompt = buildSystemPrompt({
      ...base,
      acquaintances: [
        { name: '林小雨', relation: '同事', bio: '' },
        { name: '大熊', relation: '大學室友', bio: '' },
      ],
      group: {
        conversationId: 'g',
        title: '下班喝一杯',
        selfId: 'self',
        members: [{ id: 'x', name: '林小雨', bio: '設計總監', relation: '同事' }],
        userName: '阿明',
        discretion: 60,
      },
    });
    expect(prompt).toContain('- 林小雨：設計總監\n  你們是：同事');
    expect(prompt).toContain('- 大熊：大學室友');
    expect(prompt.match(/- 林小雨/g)).toHaveLength(1);
  });

  it('沒有相關的角色時不出現這一段', () => {
    expect(buildSystemPrompt(base)).not.toContain('你生活裡認識的人');
  });
});

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('相關的角色', () => {
  const { db, pool } = createDb(url ?? '');
  const mediaDir = mkdtempSync(path.join(tmpdir(), 'acc-media-'));
  let app: FastifyInstance;
  let profileId: string;
  const calls: string[] = [];
  const fetchFn = async (_u: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    calls.push(body.messages.at(-1).content);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"issues": []}' } }], usage: {} }));
  };

  const create = async (payload: Record<string, unknown>) => {
    const res = await app.inject({ method: 'POST', url: '/api/avatars', payload });
    return { status: res.statusCode, body: res.json() as AvatarDto };
  };
  const get = async (id: string) => (await app.inject({ method: 'GET', url: `/api/avatars/${id}` })).json() as AvatarDto;

  beforeAll(async () => {
    await runMigrations(db);
    app = await buildApp({
      db,
      box: new SecretBox('test-secret-0123456789'),
      events: { publish: async () => {} },
      jobs: { add: async () => {} },
      hub: new WsHub(),
      mediaDir,
      fetchFn: fetchFn as never,
    });
  });

  beforeEach(async () => {
    calls.length = 0;
    await db.execute(sql`truncate settings, llm_profiles, avatars, conversations, conversation_members, messages, memories, relationships, avatar_links, usage_log cascade`);
    const [p] = await db.insert(llmProfiles).values({ name: 'u', provider: 'openai-compatible', baseUrl: 'http://llm.test/v1', model: 'util' }).returning();
    profileId = p!.id;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    rmSync(mediaDir, { recursive: true, force: true });
  });

  it('建立時設定的關係兩邊都看得到，也建立了兩個 avatar 之間的關係', async () => {
    const { body: a } = await create({ name: '林小雨', bio: '設計總監', persona: SAMPLE_PERSONA });
    const { body: b } = await create({ name: '大熊', bio: '' });
    const { status, body: c } = await create({
      name: '阿哲',
      bio: '設計師',
      links: [
        { avatarId: a.id, relation: '同一間設計公司的同事，林小雨是阿哲的主管' },
        { avatarId: b.id, relation: '大學室友' },
      ],
    });
    expect(status).toBe(201);
    expect(c.links).toHaveLength(2);
    expect((await get(a.id)).links).toEqual([{ avatarId: c.id, relation: '同一間設計公司的同事，林小雨是阿哲的主管' }]);
    const list = (await app.inject({ method: 'GET', url: '/api/avatars' })).json() as AvatarDto[];
    expect(list.find((x) => x.id === b.id)!.links).toEqual([{ avatarId: c.id, relation: '大學室友' }]);
    const rels = await db.select().from(relationships).where(eq(relationships.target, `avatar:${c.id}`));
    expect(rels.map((r) => r.stage)).toEqual(['acquaintance', 'acquaintance']);
  });

  it('更新時整份取代；省略 links 時不變；不存在的 avatar 會被拒絕而且不會建立', async () => {
    const { body: a } = await create({ name: '林小雨', bio: '' });
    const { body: b } = await create({ name: '大熊', bio: '' });
    const { body: c } = await create({ name: '阿哲', bio: '', links: [{ avatarId: a.id, relation: '同事' }] });

    const put = (payload: Record<string, unknown>) => app.inject({ method: 'PUT', url: `/api/avatars/${c.id}`, payload: { name: '阿哲', bio: '', ...payload } });
    expect((await put({})).json().links).toEqual([{ avatarId: a.id, relation: '同事' }]);
    expect((await put({ links: [{ avatarId: b.id, relation: '室友' }, { avatarId: c.id, relation: '自己' }] })).json().links).toEqual([
      { avatarId: b.id, relation: '室友' },
    ]);
    expect((await get(a.id)).links).toEqual([]);

    const missing = { avatarId: '00000000-0000-4000-8000-00000000dead', relation: '同事' };
    expect((await put({ name: '改名', links: [missing] })).statusCode).toBe(400);
    expect((await get(c.id)).name).toBe('阿哲');
    expect((await create({ name: '新的', bio: '', links: [missing] })).status).toBe(400);
    const all = (await app.inject({ method: 'GET', url: '/api/avatars' })).json() as AvatarDto[];
    expect(all.map((x) => x.name).sort()).toEqual(['大熊', '阿哲', '林小雨'].sort());

    // 刪除其中一個，關聯也一起消失
    await app.inject({ method: 'DELETE', url: `/api/avatars/${b.id}` });
    expect((await get(c.id)).links).toEqual([]);
  });

  it('AI 補完與一致性檢查會附上參考角色的設定', async () => {
    const { body: a } = await create({ name: '林小雨', bio: '設計總監', persona: SAMPLE_PERSONA });
    const settings = appSettingsSchema.parse({ utilityLlm: { profileId, params: {} } });
    const ctx = { db, box: new SecretBox('test-secret-0123456789'), fetchFn: fetchFn as never };
    const references = [{ avatarId: a.id, relation: '同一間設計公司的同事' }];

    await generatePersona(ctx, settings, { name: '阿哲', bio: '', persona: {}, locks: [], references, only: ['basic.age'] });
    expect(calls[0]).toContain('# 相關的角色（已經存在，新的設定要和他們一致）');
    expect(calls[0]).toContain('### 林小雨');
    expect(calls[0]).toContain('你們的關係：同一間設計公司的同事');
    expect(calls[0]).toContain(`住在：${SAMPLE_PERSONA.basic.location}`);
    expect(calls[0]).toContain('# 和相關的角色');

    await checkPersona(ctx, settings, { name: '阿哲', bio: '', persona: {}, locks: [], references });
    expect(calls.at(-1)).toContain('### 林小雨');
    expect(calls.at(-1)).toContain('也要檢查和相關的角色有沒有對不上的地方');

    calls.length = 0;
    await generatePersona(ctx, settings, { name: '阿哲', bio: '', persona: {}, locks: [], references: [], only: ['basic.age'] });
    expect(calls[0]).not.toContain('相關的角色');
  });

  it('聊天時：一對一列出認識的人，群組成員旁邊寫出關係', async () => {
    const { body: a } = await create({ name: '林小雨', bio: '設計總監' });
    const { body: b } = await create({ name: '阿哲', bio: '設計師', links: [{ avatarId: a.id, relation: '同一間設計公司的同事' }] });
    const dm = (await app.inject({ method: 'GET', url: `/api/debug/preview/${b.dmConversationId}` })).json();
    expect(dm.system).toContain('## 你生活裡認識的人\n- 林小雨：同一間設計公司的同事\n  設計總監');

    const g = await app.inject({ method: 'POST', url: '/api/conversations', payload: { title: '公司', avatarIds: [a.id, b.id] } });
    expect(g.statusCode).toBe(201);
    const group = (await app.inject({ method: 'GET', url: `/api/debug/preview/${g.json().id}?avatarId=${a.id}` })).json();
    expect(group.system).toContain('- 阿哲：設計師\n  你們是：同一間設計公司的同事');
    expect(group.system).not.toContain('你生活裡認識的人');
  });

  it('匯出全部再匯入時保留一起匯出的 avatar 之間的關聯', async () => {
    const { body: a } = await create({ name: '林小雨', bio: '' });
    const { body: b } = await create({ name: '阿哲', bio: '', links: [{ avatarId: a.id, relation: '同事' }] });
    const file = (await app.inject({ method: 'GET', url: '/api/avatars/export' })).json() as TransferFile;
    expect(file.avatars[0]!.links).toEqual([{ index: 1, relation: '同事' }]);
    expect(file.avatars[1]!.links).toEqual([{ index: 0, relation: '同事' }]);

    const res = await app.inject({ method: 'POST', url: '/api/avatars/import', payload: { file, profileId: null, include: { memories: false, history: false } } });
    expect(res.statusCode).toBe(200);
    const [x, y] = (res.json() as ImportResultDto).avatars;
    expect((await get(x!.id)).links).toEqual([{ avatarId: y!.id, relation: '同事' }]);
    expect((await get(y!.id)).links).toEqual([{ avatarId: x!.id, relation: '同事' }]);
    const rel = await db
      .select()
      .from(relationships)
      .where(and(eq(relationships.avatarId, x!.id), eq(relationships.target, `avatar:${y!.id}`)));
    expect(rel).toHaveLength(1);
    // 原本的那一對還在，總共兩對
    expect(await db.select().from(avatarLinks)).toHaveLength(2);
    expect(b.links).toHaveLength(1);
  });
});
