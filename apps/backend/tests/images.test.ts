// 圖片訊息與 avatar 的照片：上傳、看圖、寫描述、生成照片、整理沒用到的檔案（TEST_DATABASE_URL 沒設定時略過）
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { appSettingsSchema, type MessageDto } from '@acc/shared';
import { buildApp } from '../src/app.ts';
import { SecretBox } from '../src/crypto.ts';
import { createDb, runMigrations } from '../src/db/client.ts';
import { avatars, conversationMembers, conversations, llmProfiles, messages } from '../src/db/schema.ts';
import type { FetchFn } from '../src/llm/index.ts';
import { MemoryLock } from '../src/lock.ts';
import { ReplyEngine } from '../src/reply/engine.ts';
import { pruneChatMedia } from '../src/services/media.ts';
import { saveSettings } from '../src/services/settings.ts';
import { WsHub } from '../src/ws.ts';
import { SAMPLE_PERSONA } from './fixtures/persona.ts';
import { fakePng } from './fixtures/images.ts';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('圖片訊息與照片', () => {
  const { db, pool } = createDb(url ?? '');
  const box = new SecretBox('test-secret-0123456789');
  const mediaDir = mkdtempSync(path.join(tmpdir(), 'acc-media-'));
  let app: FastifyInstance;
  /** 每次聊天模型被呼叫時的 body；圖片模型另外記 */
  let chatBodies: { url: string; body: any }[];
  let imageBodies: any[];
  let reply: (body: any) => string;
  const fetchFn = (async (u: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    if (u.includes(':generateContent')) {
      imageBodies.push(body);
      const png = fakePng(768, 1024).toString('base64');
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png } }] } }] }));
    }
    chatBodies.push({ url: u, body });
    return new Response(JSON.stringify({ choices: [{ message: { content: reply(body) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  }) as unknown as FetchFn;

  let visionProfile: string;
  let blindProfile: string;
  let imageProfile: string;
  let avatarId: string;
  let conversationId: string;

  const engine = () =>
    new ReplyEngine({ db, box, events: { publish: async () => {} }, lock: new MemoryLock(), fetchFn, sleep: async () => {}, random: () => 0.5, mediaDir });

  async function upload(buf: Buffer, name = 'a.png') {
    const form = new FormData();
    form.append('file', new Blob([buf]), name);
    const body = new Response(form);
    return app.inject({ method: 'POST', url: '/api/uploads', headers: Object.fromEntries(body.headers), payload: Buffer.from(await body.arrayBuffer()) });
  }

  async function sendImage(content = '') {
    const up = (await upload(fakePng(800, 600))).json();
    const res = await app.inject({ method: 'POST', url: `/api/conversations/${conversationId}/messages`, payload: { content, image: up.id } });
    expect(res.statusCode).toBe(201);
    await new Promise((r) => setTimeout(r, 5));
    return res.json() as MessageDto;
  }

  const lastAvatarMessages = async () =>
    db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt), asc(messages.seq));

  beforeAll(async () => {
    await runMigrations(db);
    app = await buildApp({ db, box, events: { publish: async () => {} }, jobs: { add: async () => {} }, hub: new WsHub(), mediaDir, fetchFn });
  });

  beforeEach(async () => {
    await db.execute(sql`truncate settings, llm_profiles, avatars, conversations, conversation_members, messages, usage_log, user_profile, memories cascade`);
    chatBodies = [];
    imageBodies = [];
    reply = () => JSON.stringify({ inner_thought: '嗯', messages: ['好可愛'] });
    const mk = async (name: string, vision: boolean | null, provider: 'openai-compatible' | 'google' = 'openai-compatible') =>
      (await db.insert(llmProfiles).values({ name, provider, baseUrl: 'http://llm.test/v1', model: name, vision }).returning())[0]!.id;
    visionProfile = await mk('vision-model', true);
    blindProfile = await mk('text-model', null);
    imageProfile = await mk('gemini-image', null, 'google');
    const [a] = await db.insert(avatars).values({ name: '小雨', persona: SAMPLE_PERSONA, llm: { profileId: visionProfile, params: {} } }).returning();
    avatarId = a!.id;
    const [c] = await db.insert(conversations).values({ type: 'dm' }).returning();
    await db.insert(conversationMembers).values({ conversationId: c!.id, avatarId });
    conversationId = c!.id;
    await saveSettings(db, appSettingsSchema.parse({ replyPacing: 'instant' }));
  });

  afterAll(async () => {
    await app?.close();
    await pool.end();
    rmSync(mediaDir, { recursive: true, force: true });
  });

  it('上傳：只收真的圖片；訊息帶上圖片後回傳網址與尺寸', async () => {
    const bad = await upload(Buffer.from('not an image'), 'evil.png');
    expect(bad.statusCode).toBe(400);
    const msg = await sendImage('我家的貓');
    expect(msg.image).toMatchObject({ width: 800, height: 600 });
    expect(msg.image!.url).toMatch(/^\/media\/uploads\/[0-9a-f-]+\.png$/);
    expect(existsSync(path.join(mediaDir, msg.image!.url.replace('/media/', '')))).toBe(true);
    const missing = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      payload: { image: '00000000-0000-0000-0000-000000000000.png' },
    });
    expect(missing.statusCode).toBe(400);
  });

  it('看得懂圖片的模型：圖片直接附在對話裡', async () => {
    await sendImage('我家的貓');
    // 經過 API 送出的訊息會排好「什麼時候看到」，測試直接要它現在回
    await engine().handle(conversationId, { force: true });
    const user = chatBodies[0]!.body.messages.at(-1);
    expect(user.content[0].text).toContain('［傳了一張圖片，見下圖］ 我家的貓');
    expect(user.content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
  });

  it('看不懂圖片：系統工具模型先寫描述（存起來重複用），avatar 看到的是描述', async () => {
    await db.update(avatars).set({ llm: { profileId: blindProfile, params: {} } }).where(eq(avatars.id, avatarId));
    await saveSettings(db, appSettingsSchema.parse({ replyPacing: 'instant', utilityLlm: { profileId: visionProfile, params: {} } }));
    reply = (body) =>
      body.messages[0].content === '你負責描述圖片。' ? '一隻橘色的貓睡在鍵盤上' : JSON.stringify({ messages: ['好可愛'] });
    await sendImage();
    await engine().handle(conversationId, { force: true });
    expect(chatBodies.map((b) => b.body.model)).toEqual(['vision-model', 'text-model']);
    const prompt = chatBodies[1]!.body.messages.at(-1).content;
    expect(prompt).toBe('［傳了一張圖片：一隻橘色的貓睡在鍵盤上］');
    const [img] = await db.select().from(messages).where(sql`${messages.meta} ? 'image'`);
    expect(img!.meta.image!.caption).toBe('一隻橘色的貓睡在鍵盤上');

    // 下一次回覆不會再描述一次
    await db.insert(messages).values({ conversationId, senderType: 'user', content: '牠叫橘子' });
    await engine().handle(conversationId);
    expect(chatBodies.filter((b) => b.body.messages[0].content === '你負責描述圖片。')).toHaveLength(1);
  });

  it('avatar 傳照片：用頭像當參考圖生成、當成圖片訊息送出；今天的張數用完就不再傳', async () => {
    const avatarImage = path.join(mediaDir, 'avatars', 'me.png');
    writeFileSync(avatarImage, fakePng(256, 256));
    await db.update(avatars).set({ imagePath: 'avatars/me.png' }).where(eq(avatars.id, avatarId));
    await saveSettings(
      db,
      appSettingsSchema.parse({ replyPacing: 'instant', imageGen: { profileId: imageProfile, model: 'gemini-image' }, photos: { enabled: true, dailyLimit: 1, style: 'realistic' } }),
    );
    reply = () => JSON.stringify({ messages: ['你看'], photo: '吧檯上剛拉好花的拿鐵' });
    await db.insert(messages).values({ conversationId, senderType: 'user', content: '在幹嘛' });
    await engine().handle(conversationId);

    expect(chatBodies[0]!.body.messages[0].content).toContain('今天最多還能傳 1 張');
    expect(imageBodies).toHaveLength(1);
    const parts = imageBodies[0].contents[0].parts;
    expect(parts[0].inlineData.data).toBe(fakePng(256, 256).toString('base64'));
    expect(parts[1].text).toContain('畫面：吧檯上剛拉好花的拿鐵');
    expect(imageBodies[0].generationConfig.imageConfig.aspectRatio).toBe('3:4');

    const rows = await lastAvatarMessages();
    const photo = rows.at(-1)!;
    expect(rows.map((r) => r.content)).toEqual(['在幹嘛', '你看', '']);
    expect(photo.meta.image).toMatchObject({ description: '吧檯上剛拉好花的拿鐵', width: 768, height: 1024 });
    expect(readFileSync(path.join(mediaDir, photo.meta.image!.path)).length).toBeGreaterThan(0);

    // 下一輪：prompt 告訴它不要再傳；就算它還是填了 photo 也不會生成
    await db.insert(messages).values({ conversationId, senderType: 'user', content: '再一張' });
    await engine().handle(conversationId);
    expect(chatBodies[1]!.body.messages[0].content).toContain('這次不要再傳');
    expect(imageBodies).toHaveLength(1);
    // 它自己傳過的照片在紀錄裡是 photo 欄位
    const own = chatBodies[1]!.body.messages.find((m: any) => m.role === 'assistant');
    expect(JSON.parse(own.content)).toEqual({ messages: ['你看'], photo: '吧檯上剛拉好花的拿鐵' });
  });

  it('沒有設定圖片模型：prompt 不提照片', async () => {
    await db.insert(messages).values({ conversationId, senderType: 'user', content: '嗨' });
    await engine().handle(conversationId);
    expect(chatBodies[0]!.body.messages[0].content).not.toContain('photo');
  });

  it('整理：放超過一天、沒有訊息用到的圖片會刪掉', async () => {
    const used = await sendImage();
    const usedPath = path.join(mediaDir, used.image!.url.replace('/media/', ''));
    const orphan = (await upload(fakePng(10, 10))).json();
    const orphanPath = path.join(mediaDir, 'uploads', orphan.id);
    const fresh = (await upload(fakePng(10, 10))).json();
    const old = new Date(Date.now() - 2 * 86_400_000);
    utimesSync(usedPath, old, old);
    utimesSync(orphanPath, old, old);
    expect(await pruneChatMedia(db, mediaDir)).toBe(1);
    expect(existsSync(usedPath)).toBe(true);
    expect(existsSync(orphanPath)).toBe(false);
    expect(existsSync(path.join(mediaDir, 'uploads', fresh.id))).toBe(true);
  });
});
