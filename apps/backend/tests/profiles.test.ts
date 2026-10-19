// 設定檔的用途（聊天、圖片生成、記憶嵌入）：舊設定的轉換、用途檢查、依用途測試（TEST_DATABASE_URL 沒設定時略過）
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { SecretBox } from '../src/crypto.ts';
import { createDb, runMigrations } from '../src/db/client.ts';
import { migrateLegacyProfileSettings } from '../src/db/legacy.ts';
import { avatars, llmProfiles, settings } from '../src/db/schema.ts';
import type { FetchFn } from '../src/llm/index.ts';
import { WsHub } from '../src/ws.ts';
import { fakePng } from './fixtures/images.ts';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('設定檔的用途', () => {
  const { db, pool } = createDb(url ?? '');
  const box = new SecretBox('test-secret-0123456789');
  const mediaDir = mkdtempSync(path.join(tmpdir(), 'acc-media-'));
  let app: FastifyInstance;
  const fetchFn = (async (u: string) => {
    if (u.includes(':generateContent'))
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: fakePng(8, 8).toString('base64') } }] } }] }));
    if (u.includes(':batchEmbedContents')) return new Response(JSON.stringify({ embeddings: [{ values: Array(768).fill(0.1) }] }));
    return new Response(JSON.stringify({ choices: [{ message: { content: '嗨' } }] }));
  }) as unknown as FetchFn;

  const profile = (values: Partial<typeof llmProfiles.$inferInsert> & { name: string }) =>
    db
      .insert(llmProfiles)
      .values({ provider: 'google', model: 'gemini-2.5-flash', apiKeyEnc: box.encrypt('gk-1'), apiKeyHint: '…k-1', ...values })
      .returning()
      .then((r) => r[0]!);
  const create = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/llm-profiles', payload });

  beforeAll(async () => {
    await runMigrations(db);
    app = await buildApp({ db, box, events: { publish: async () => {} }, jobs: { add: async () => {} }, hub: new WsHub(), mediaDir, fetchFn });
  });

  beforeEach(async () => {
    await db.execute(sql`truncate settings, llm_profiles, avatars, conversations, conversation_members cascade`);
  });

  afterAll(async () => {
    await app?.close();
    await pool.end();
    rmSync(mediaDir, { recursive: true, force: true });
  });

  it('舊設定：沒拿來聊天的設定檔直接改用途，也拿來聊天的複製一份（共用 key）；只做一次', async () => {
    const banana = await profile({ name: 'nano-banana', model: 'gemini-nano-banana' });
    const flash = await profile({ name: 'Gemini Flash' });
    await db.insert(avatars).values({ name: '小雨', llm: { profileId: flash.id, params: {} } });
    await db.insert(settings).values({
      id: 1,
      data: {
        timezone: 'Asia/Taipei',
        imageGen: { profileId: banana.id, model: 'gemini-2.5-flash-image' },
        embedding: { profileId: flash.id, model: 'gemini-embedding-001' },
      },
    });
    await migrateLegacyProfileSettings(db);
    await migrateLegacyProfileSettings(db);

    const rows = await db.select().from(llmProfiles);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.id === banana.id)).toMatchObject({ kind: 'image', model: 'gemini-2.5-flash-image' });
    expect(rows.find((r) => r.id === flash.id)).toMatchObject({ kind: 'chat', model: 'gemini-2.5-flash' });
    const copy = rows.find((r) => r.kind === 'embedding')!;
    expect(copy).toMatchObject({ name: 'Gemini Flash（嵌入）', model: 'gemini-embedding-001', apiKeyEnc: flash.apiKeyEnc });
    const [s] = await db.select().from(settings);
    expect(s!.data).toMatchObject({ imageGen: { profileId: banana.id }, embedding: { profileId: copy.id }, timezone: 'Asia/Taipei' });
    expect((s!.data as { imageGen: object }).imageGen).not.toHaveProperty('model');
  });

  it('用途要對：圖片生成只能選圖片的設定檔、avatar 的大腦只能選聊天的', async () => {
    const chat = (await create({ name: '聊天', provider: 'google', model: 'gemini-2.5-flash', apiKey: 'k' })).json();
    const image = (await create({ kind: 'image', name: '圖片', provider: 'google', model: 'gemini-2.5-flash-image', apiKey: 'k' })).json();
    expect(image.kind).toBe('image');

    const wrongImage = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { imageGen: { profileId: chat.id } } });
    expect(wrongImage.statusCode).toBe(400);
    expect(wrongImage.json().error).toContain('圖片生成用的');
    expect((await app.inject({ method: 'PATCH', url: '/api/settings', payload: { imageGen: { profileId: image.id } } })).statusCode).toBe(200);

    const avatar = await app.inject({ method: 'POST', url: '/api/avatars', payload: { name: 'x', llm: { profileId: image.id, params: {} } } });
    expect(avatar.statusCode).toBe(400);
    const util = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { utilityLlm: { profileId: image.id, params: {} } } });
    expect(util.statusCode).toBe(400);

    // Anthropic 沒有圖片生成
    expect((await create({ kind: 'image', name: 'a', provider: 'anthropic', model: 'x', apiKey: 'k' })).statusCode).toBe(400);
  });

  it('使用中的設定檔不能改用途', async () => {
    const chat = (await create({ name: '聊天', provider: 'google', model: 'gemini-2.5-flash', apiKey: 'k' })).json();
    await app.inject({ method: 'POST', url: '/api/avatars', payload: { name: 'x', llm: { profileId: chat.id, params: {} } } });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/llm-profiles/${chat.id}`,
      payload: { kind: 'embedding', name: '聊天', provider: 'google', model: 'gemini-embedding-001' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('1 個 avatar');
  });

  it('測試連線依用途：圖片生成回一張圖、記憶嵌入回維度', async () => {
    const image = (await create({ kind: 'image', name: '圖片', provider: 'google', model: 'gemini-2.5-flash-image', apiKey: 'k' })).json();
    const emb = (await create({ kind: 'embedding', name: '嵌入', provider: 'google', model: 'gemini-embedding-001', apiKey: 'k' })).json();
    const a = (await app.inject({ method: 'POST', url: `/api/llm-profiles/${image.id}/test`, payload: {} })).json();
    expect(a).toMatchObject({ ok: true });
    expect(a.image).toMatch(/^data:image\/png;base64,/);
    const b = (await app.inject({ method: 'POST', url: `/api/llm-profiles/${emb.id}/test`, payload: {} })).json();
    expect(b).toMatchObject({ ok: true, reply: '嵌入成功：768 維向量' });
  });
});
