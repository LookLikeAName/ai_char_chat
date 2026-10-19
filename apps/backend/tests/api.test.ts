// 用真的 PostgreSQL 跑 API（TEST_DATABASE_URL 沒設定時略過）
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ServerEvent } from '@acc/shared';
import { buildApp } from '../src/app.ts';
import { SecretBox } from '../src/crypto.ts';
import { createDb, runMigrations } from '../src/db/client.ts';
import { llmProfiles, messages } from '../src/db/schema.ts';
import type { AgentJob } from '../src/jobs.ts';
import type { FetchFn } from '../src/llm/index.ts';
import { WsHub } from '../src/ws.ts';
import { SAMPLE_PERSONA } from './fixtures/persona.ts';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('API', () => {
  const { db, pool } = createDb(url ?? '');
  const events: ServerEvent[] = [];
  const jobs: AgentJob[] = [];
  const llmCalls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const mediaDir = mkdtempSync(path.join(tmpdir(), 'acc-media-'));
  let app: FastifyInstance;

  const fetchFn = (async (u: string, init: RequestInit) => {
    llmCalls.push({ url: u, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined });
    if (u.includes(':generateContent')) {
      const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png } }] } }] }));
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '我是測試模型' }, finish_reason: 'stop' }], usage: {} }),
    );
  }) as unknown as FetchFn;

  beforeAll(async () => {
    await runMigrations(db);
    app = await buildApp({
      db,
      box: new SecretBox('test-secret-0123456789'),
      events: { publish: async (e) => void events.push(e) },
      jobs: { add: async (j) => void jobs.push(j) },
      hub: new WsHub(),
      mediaDir,
      fetchFn,
    });
  });

  beforeEach(async () => {
    await db.execute(sql`truncate settings, llm_profiles, avatars, conversations, conversation_members, messages, user_profile cascade`);
    events.length = 0;
    jobs.length = 0;
    llmCalls.length = 0;
  });

  afterAll(async () => {
    await app?.close();
    await pool.end();
    rmSync(mediaDir, { recursive: true, force: true });
  });

  async function createProfile(extra: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/llm-profiles',
      payload: {
        name: '本機',
        provider: 'openai-compatible',
        baseUrl: 'http://llm.test/v1',
        model: 'test-model',
        apiKey: 'sk-secret-9876',
        defaults: { temperature: 0.7, maxOutputTokens: 300 },
        ...extra,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  describe('設定', () => {
    it('沒有存過時回傳預設值', async () => {
      const res = await app.inject({ url: '/api/settings' });
      expect(res.json()).toMatchObject({ timezone: 'Asia/Taipei', adultContent: false, utilityLlm: null });
    });

    it('拒絕無效的時區與不存在的設定檔', async () => {
      const bad = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { timezone: 'Mars/Base' } });
      expect(bad.statusCode).toBe(400);
      const missing = await app.inject({
        method: 'PATCH',
        url: '/api/settings',
        payload: { utilityLlm: { profileId: '00000000-0000-4000-8000-000000000000', params: {} } },
      });
      expect(missing.statusCode).toBe(404);
    });

    it('部分更新會保留其他欄位', async () => {
      await app.inject({ method: 'PATCH', url: '/api/settings', payload: { adultContent: true } });
      const res = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { timezone: 'Asia/Tokyo' } });
      expect(res.json()).toMatchObject({ timezone: 'Asia/Tokyo', adultContent: true });
      expect(events).toContainEqual({ type: 'settings.changed' });
    });
  });

  describe('LLM 設定檔', () => {
    it('API key 加密存放，回應裡只有提示', async () => {
      const dto = await createProfile();
      expect(dto).toMatchObject({ hasApiKey: true, apiKeyHint: '…9876', usedBy: 0 });
      expect(JSON.stringify(dto)).not.toContain('sk-secret');
      const [row] = await db.select().from(llmProfiles);
      expect(row!.apiKeyEnc).not.toContain('sk-secret');
    });

    it('更新時沒帶 apiKey 就保留，帶 null 就清除', async () => {
      const dto = await createProfile();
      const body = { name: '改名', provider: 'openai-compatible', baseUrl: 'http://llm.test/v1', model: 'm2' };
      const kept = await app.inject({ method: 'PUT', url: `/api/llm-profiles/${dto.id}`, payload: body });
      expect(kept.json()).toMatchObject({ name: '改名', model: 'm2', hasApiKey: true });
      const cleared = await app.inject({ method: 'PUT', url: `/api/llm-profiles/${dto.id}`, payload: { ...body, apiKey: null } });
      expect(cleared.json()).toMatchObject({ hasApiKey: false, apiKeyHint: null });
    });

    it('測試連線時用解密後的 key，並套上覆寫參數', async () => {
      const dto = await createProfile();
      const res = await app.inject({
        method: 'POST',
        url: `/api/llm-profiles/${dto.id}/test`,
        payload: { params: { temperature: 1.2 } },
      });
      expect(res.json()).toMatchObject({ ok: true, reply: '我是測試模型', params: { temperature: 1.2, maxOutputTokens: 300 } });
      expect(llmCalls[0]!.headers.authorization).toBe('Bearer sk-secret-9876');
      expect(llmCalls[0]!.body).toMatchObject({ model: 'test-model', temperature: 1.2, max_tokens: 300 });
    });

    it('測試未儲存的表單時，可以沿用已存的 key', async () => {
      const dto = await createProfile();
      const res = await app.inject({
        method: 'POST',
        url: '/api/llm-profiles/test-draft',
        payload: { profileId: dto.id, provider: 'openai-compatible', baseUrl: 'http://other.test/v1', model: 'draft-model' },
      });
      expect(res.json().ok).toBe(true);
      expect(llmCalls[0]!.url).toBe('http://other.test/v1/chat/completions');
      expect(llmCalls[0]!.headers.authorization).toBe('Bearer sk-secret-9876');
    });

    it('被 avatar 綁定時不能刪除', async () => {
      const dto = await createProfile();
      await app.inject({ method: 'POST', url: '/api/avatars', payload: { name: '小雨', llm: { profileId: dto.id } } });
      const del = await app.inject({ method: 'DELETE', url: `/api/llm-profiles/${dto.id}` });
      expect(del.statusCode).toBe(409);
      const list = await app.inject({ url: '/api/llm-profiles' });
      expect(list.json()[0].usedBy).toBe(1);
    });
  });

  describe('avatar 與聊天', () => {
    it('建立 avatar 時一起建立一對一聊天，綁定保留覆寫參數', async () => {
      const profile = await createProfile();
      const res = await app.inject({
        method: 'POST',
        url: '/api/avatars',
        payload: { name: '小雨', bio: '咖啡店店長', llm: { profileId: profile.id, params: { temperature: 1.1 } } },
      });
      expect(res.statusCode).toBe(201);
      const avatar = res.json();
      expect(avatar.llm).toEqual({ profileId: profile.id, params: { temperature: 1.1 } });
      const convs = (await app.inject({ url: '/api/conversations' })).json();
      expect(convs).toHaveLength(1);
      expect(convs[0]).toMatchObject({ id: avatar.dmConversationId, type: 'dm', title: '小雨', memberAvatarIds: [avatar.id] });
    });

    it('送出訊息：寫入、發佈事件、投遞工作', async () => {
      const avatar = (await app.inject({ method: 'POST', url: '/api/avatars', payload: { name: '阿哲' } })).json();
      const conv = avatar.dmConversationId;
      const sent = await app.inject({ method: 'POST', url: `/api/conversations/${conv}/messages`, payload: { content: '  你好  ' } });
      expect(sent.statusCode).toBe(201);
      const msg = sent.json();
      expect(msg).toMatchObject({ content: '你好', senderType: 'user' });
      expect(events).toContainEqual({ type: 'message.created', message: msg });
      expect(jobs).toEqual([{ kind: 'reply', conversationId: conv }]);

      const page = (await app.inject({ url: `/api/conversations/${conv}/messages` })).json();
      expect(page.messages.map((m: { content: string }) => m.content)).toEqual(['你好']);
      const convs = (await app.inject({ url: '/api/conversations' })).json();
      expect(convs[0].lastMessage.content).toBe('你好');
    });

    it('未讀數：avatar 的新訊息算未讀，標記已讀後歸零', async () => {
      const avatar = (await app.inject({ method: 'POST', url: '/api/avatars', payload: { name: '阿哲' } })).json();
      const conv = avatar.dmConversationId;
      await db.insert(messages).values([
        { conversationId: conv, senderType: 'avatar', senderAvatarId: avatar.id, content: '在嗎' },
        { conversationId: conv, senderType: 'avatar', senderAvatarId: avatar.id, content: '？' },
      ]);
      expect((await app.inject({ url: '/api/conversations' })).json()[0].unreadCount).toBe(2);
      expect((await app.inject({ method: 'POST', url: `/api/conversations/${conv}/read` })).statusCode).toBe(204);
      expect((await app.inject({ url: '/api/conversations' })).json()[0].unreadCount).toBe(0);
    });

    it('重試：移除錯誤訊息並重新投遞回覆', async () => {
      const avatar = (await app.inject({ method: 'POST', url: '/api/avatars', payload: { name: '阿哲' } })).json();
      const conv = avatar.dmConversationId;
      await db.insert(messages).values([
        { conversationId: conv, senderType: 'user', content: '嗨' },
        { conversationId: conv, senderType: 'system', content: '失敗', meta: { systemKind: 'error' } },
        { conversationId: conv, senderType: 'system', content: '提示', meta: { systemKind: 'notice' } },
      ]);
      expect((await app.inject({ method: 'POST', url: `/api/conversations/${conv}/retry` })).statusCode).toBe(202);
      const page = (await app.inject({ url: `/api/conversations/${conv}/messages` })).json();
      expect(page.messages.map((m: { content: string }) => m.content)).toEqual(['嗨', '提示']);
      expect(jobs).toEqual([{ kind: 'reply', conversationId: conv, force: true }]);
      expect(events).toContainEqual({ type: 'messages.changed', conversationId: conv });
    });

    it('空白訊息被拒絕', async () => {
      const avatar = (await app.inject({ method: 'POST', url: '/api/avatars', payload: { name: '阿哲' } })).json();
      const res = await app.inject({
        method: 'POST',
        url: `/api/conversations/${avatar.dmConversationId}/messages`,
        payload: { content: '   ' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('上傳頭像後可以從 /media 取得，刪除 avatar 時連聊天一起刪', async () => {
      const avatar = (await app.inject({ method: 'POST', url: '/api/avatars', payload: { name: '小雨' } })).json();
      const boundary = '----acc-test';
      const png = Buffer.from('89504e470d0a1a0a', 'hex');
      const payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
        png,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const up = await app.inject({
        method: 'POST',
        url: `/api/avatars/${avatar.id}/image`,
        payload,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      });
      expect(up.statusCode).toBe(200);
      const imageUrl = up.json().imageUrl as string;
      expect(imageUrl).toMatch(/^\/media\/avatars\/.+\.png$/);
      const file = await app.inject({ url: imageUrl });
      expect(file.statusCode).toBe(200);

      expect((await app.inject({ method: 'DELETE', url: `/api/avatars/${avatar.id}` })).statusCode).toBe(204);
      expect((await app.inject({ url: '/api/conversations' })).json()).toEqual([]);
      expect((await app.inject({ url: imageUrl })).statusCode).toBe(404);
    });

    it('不接受非圖片檔', async () => {
      const avatar = (await app.inject({ method: 'POST', url: '/api/avatars', payload: { name: '小雨' } })).json();
      const boundary = '----acc-test';
      const res = await app.inject({
        method: 'POST',
        url: `/api/avatars/${avatar.id}/image`,
        payload: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--${boundary}--\r\n`,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('人格設定', () => {
    it('不完整的人格設定不能儲存，全空或全部填滿才行', async () => {
      const avatar = (await app.inject({ method: 'POST', url: '/api/avatars', payload: { name: '小雨' } })).json();
      expect(avatar).toMatchObject({ persona: {}, personaLocks: [], personaComplete: false });

      const partial = await app.inject({
        method: 'PUT',
        url: `/api/avatars/${avatar.id}`,
        payload: { name: '小雨', persona: { basic: { age: 27 } } },
      });
      expect(partial.statusCode).toBe(400);
      expect(partial.json().error).toMatch(/還有 \d+ 個欄位沒填/);

      const minor = await app.inject({
        method: 'PUT',
        url: `/api/avatars/${avatar.id}`,
        payload: { name: '小雨', persona: { ...SAMPLE_PERSONA, basic: { ...SAMPLE_PERSONA.basic, age: 16 } } },
      });
      expect(minor.statusCode).toBe(400);
      expect(minor.json().error).toContain('年齡');

      const full = await app.inject({
        method: 'PUT',
        url: `/api/avatars/${avatar.id}`,
        payload: { name: '小雨', persona: SAMPLE_PERSONA, personaLocks: ['basic.age', 'bogus.path'] },
      });
      expect(full.statusCode).toBe(200);
      expect(full.json()).toMatchObject({ personaComplete: true, personaLocks: ['basic.age'] });

      // 不帶 persona 時不變更
      const rename = await app.inject({ method: 'PUT', url: `/api/avatars/${avatar.id}`, payload: { name: '林小雨' } });
      expect(rename.json()).toMatchObject({ name: '林小雨', personaComplete: true });
    });

    it('沒有設定系統工具模型時，AI 補完回 400', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/avatars/persona/generate', payload: { name: '小雨' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('系統工具模型');
    });

    it('用 Gemini 生成頭像', async () => {
      const profile = (
        await app.inject({
          method: 'POST',
          url: '/api/llm-profiles',
          payload: { name: 'g', provider: 'google', model: 'gemini-x', apiKey: 'gk-1234' },
        })
      ).json();
      const avatar = (await app.inject({ method: 'POST', url: '/api/avatars', payload: { name: '小雨' } })).json();
      const noSetting = await app.inject({
        method: 'POST',
        url: `/api/avatars/${avatar.id}/image/generate`,
        payload: { prompt: '短髮女生' },
      });
      expect(noSetting.statusCode).toBe(400);

      await app.inject({
        method: 'PATCH',
        url: '/api/settings',
        payload: { imageGen: { profileId: profile.id, model: 'gemini-image-x' } },
      });
      const res = await app.inject({ method: 'POST', url: `/api/avatars/${avatar.id}/image/generate`, payload: { prompt: '短髮女生' } });
      expect(res.statusCode).toBe(200);
      expect(res.json().imageUrl).toMatch(/\.png$/);
      const call = llmCalls.at(-1)!;
      expect(call.url).toContain('models/gemini-image-x:generateContent');
      expect(call.headers['x-goog-api-key']).toBe('gk-1234');
      expect(call.body.generationConfig.responseModalities).toEqual(['IMAGE']);
      expect((await app.inject({ url: res.json().imageUrl })).statusCode).toBe(200);
    });
  });

  describe('玩家 profile', () => {
    it('第一次使用時沒有偏好；稱呼必填', async () => {
      const res = (await app.inject({ url: '/api/profile' })).json();
      expect(res).toMatchObject({ preferences: null, answers: {}, summary: '', summaryStale: false });
      expect(res.results).toEqual({ bigFive: null, attachment: null, values: null });
      const bad = await app.inject({ method: 'PUT', url: '/api/profile/preferences', payload: { nickname: ' ' } });
      expect(bad.statusCode).toBe(400);
      const ok = await app.inject({
        method: 'PUT',
        url: '/api/profile/preferences',
        payload: { nickname: '阿明', interests: ['爬山'], chatStyles: ['banter'] },
      });
      expect(ok.json().preferences).toMatchObject({ nickname: '阿明', interests: ['爬山'], chatStyles: ['banter'], romance: null });
      expect(events).toContainEqual({ type: 'profile.changed' });
    });

    it('作答可以分段存、清除單題，答完自動計分', async () => {
      await app.inject({
        method: 'PATCH',
        url: '/api/profile/answers',
        payload: { instrument: 'attachment', answers: { ecr1: 7, ecr2: 7, bogus: 3, ecr3: 99 } },
      });
      let res = (await app.inject({ url: '/api/profile' })).json();
      expect(res.answers.attachment).toEqual({ ecr1: 7, ecr2: 7 });
      expect(res.results.attachment).toBeNull();
      await app.inject({ method: 'PATCH', url: '/api/profile/answers', payload: { instrument: 'attachment', answers: { ecr2: null } } });
      res = (await app.inject({ url: '/api/profile' })).json();
      expect(res.answers.attachment).toEqual({ ecr1: 7 });
      const rest = { ecr2: 7, ecr3: 7, ecr4: 7, ecr5: 1, ecr6: 1, ecr7: 6, ecr8: 6, ecr9: 6 };
      res = (
        await app.inject({ method: 'PATCH', url: '/api/profile/answers', payload: { instrument: 'attachment', answers: rest } })
      ).json();
      expect(res.results.attachment).toEqual({ anxiety: 6, avoidance: 1, style: 'anxious' });
    });

    it('摘要：需要偏好與系統工具模型；之後作答有變更就標示過期', async () => {
      expect((await app.inject({ method: 'POST', url: '/api/profile/summary/generate' })).statusCode).toBe(400);
      await app.inject({ method: 'PUT', url: '/api/profile/preferences', payload: { nickname: '阿明' } });
      const noUtil = await app.inject({ method: 'POST', url: '/api/profile/summary/generate' });
      expect(noUtil.json().error).toContain('系統工具模型');

      const profile = await createProfile();
      await app.inject({ method: 'PATCH', url: '/api/settings', payload: { utilityLlm: { profileId: profile.id, params: {} } } });
      const gen = (await app.inject({ method: 'POST', url: '/api/profile/summary/generate' })).json();
      expect(gen).toMatchObject({ summary: '我是測試模型', summaryStale: false });
      const call = llmCalls.at(-1)!;
      expect(call.body.response_format).toBeUndefined();
      expect(call.body.messages.at(-1).content).toContain('希望被稱呼為：阿明');

      await app.inject({ method: 'PATCH', url: '/api/profile/answers', payload: { instrument: 'bigFive', answers: { ipip1: 4 } } });
      expect((await app.inject({ url: '/api/profile' })).json().summaryStale).toBe(true);
      const edited = (await app.inject({ method: 'PUT', url: '/api/profile/summary', payload: { summary: '自己改的' } })).json();
      expect(edited).toMatchObject({ summary: '自己改的', summaryStale: false });
    });
  });

  it('WebSocket 連線後收到 hello', async () => {
    // hello 在連線建立時立刻送出，所以監聽器要在 onInit 就掛上
    let resolveFirst!: (s: string) => void;
    const first = new Promise<string>((r) => (resolveFirst = r));
    const ws = await app.injectWS('/ws', {}, { onInit: (s) => s.once('message', (d) => resolveFirst(d.toString())) });
    expect(JSON.parse(await first).type).toBe('hello');
    ws.terminate();
  });
});
