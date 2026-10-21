// 匯出／匯入設定（TEST_DATABASE_URL 沒設定時略過）
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppSettings, LlmProfileDto, ProfileDto, SettingsFile, SettingsImportResultDto } from '@acc/shared';
import { buildApp } from '../src/app.ts';
import { SecretBox } from '../src/crypto.ts';
import { createDb, runMigrations } from '../src/db/client.ts';
import { llmProfiles } from '../src/db/schema.ts';
import { WsHub } from '../src/ws.ts';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('設定的匯出／匯入', () => {
  const { db, pool } = createDb(url ?? '');
  const mediaDir = mkdtempSync(path.join(tmpdir(), 'acc-media-'));
  let app: FastifyInstance;

  const inject = async <T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT', u: string, payload?: unknown) => {
    const res = await app.inject({ method, url: u, payload: payload as never });
    return { status: res.statusCode, body: res.json() as T, headers: res.headers };
  };
  const reset = () => db.execute(sql`truncate settings, llm_profiles, avatars, user_profile cascade`);

  /** 建立兩個設定檔並讓設定指向它們 */
  async function seed() {
    const chat = (await inject<LlmProfileDto>('POST', '/api/llm-profiles', { name: 'Gemini', provider: 'google', model: 'gemini-flash', apiKey: 'key-chat-123456' })).body;
    const good = (await inject<LlmProfileDto>('POST', '/api/llm-profiles', { name: 'Claude', provider: 'anthropic', model: 'claude-x', apiKey: 'key-good-123456' })).body;
    const emb = (await inject<LlmProfileDto>('POST', '/api/llm-profiles', { kind: 'embedding', name: '嵌入', provider: 'google', model: 'gemini-embedding-2' })).body;
    await inject('PATCH', '/api/settings', {
      timezone: 'Asia/Tokyo',
      adultContent: true,
      utilityLlm: { profileId: chat.id, params: { temperature: 0.2 } },
      utilityByTask: { persona: { profileId: good.id, params: {} } },
      embedding: { profileId: emb.id },
    });
    await inject('PUT', '/api/profile/preferences', { nickname: '阿明', interests: ['爬山'] });
    await inject('PUT', '/api/profile/summary', { summary: '慢熟但真誠' });
    return { chat, good, emb };
  }

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

  beforeEach(reset);

  afterAll(async () => {
    await app.close();
    await pool.end();
    rmSync(mediaDir, { recursive: true, force: true });
  });

  it('預設不帶 API key 與玩家 profile；勾選才帶', async () => {
    await seed();
    const plain = await inject<SettingsFile>('GET', '/api/settings/export');
    expect(plain.headers['content-disposition']).toContain('attachment');
    expect(plain.body.format).toBe('ai-char-chat-settings');
    expect(plain.body.profiles).toHaveLength(3);
    expect(plain.body.profiles.every((p) => !p.apiKey)).toBe(true);
    expect(plain.body.player).toBeUndefined();
    expect(JSON.stringify(plain.body)).not.toContain('key-chat');

    const full = await inject<SettingsFile>('GET', '/api/settings/export?apiKeys=true&player=true');
    expect(full.body.profiles.find((p) => p.name === 'Gemini')!.apiKey).toBe('key-chat-123456');
    expect(full.body.player).toMatchObject({ summary: '慢熟但真誠', preferences: { nickname: '阿明' } });
  });

  it('匯入到空的系統：建立設定檔、設定改指向新的 id、玩家 profile 也回來', async () => {
    const { chat, good } = await seed();
    // Gemini 的備援是 Claude
    await db.update(llmProfiles).set({ fallback: { profileId: good.id, onRefusal: true, onError: false } }).where(sql`id = ${chat.id}`);
    const file = (await inject<SettingsFile>('GET', '/api/settings/export?apiKeys=true&player=true')).body;
    await reset();

    const r = await inject<SettingsImportResultDto>('POST', '/api/settings/import', { file });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ profiles: { created: 3, reused: 0, keys: 2 }, settings: true, player: true, warnings: [] });

    const profiles = (await inject<LlmProfileDto[]>('GET', '/api/llm-profiles')).body;
    const byName = (n: string) => profiles.find((p) => p.name === n)!;
    expect(byName('Gemini').hasApiKey).toBe(true);
    expect(byName('Gemini').fallback).toEqual({ profileId: byName('Claude').id, onRefusal: true, onError: false });
    const s = (await inject<AppSettings>('GET', '/api/settings')).body;
    expect(s).toMatchObject({ timezone: 'Asia/Tokyo', adultContent: true });
    expect(s.utilityLlm).toEqual({ profileId: byName('Gemini').id, params: { temperature: 0.2 } });
    expect(s.utilityByTask.persona?.profileId).toBe(byName('Claude').id);
    expect(s.embedding?.profileId).toBe(byName('嵌入').id);
    const player = (await inject<ProfileDto>('GET', '/api/profile')).body;
    expect(player).toMatchObject({ summary: '慢熟但真誠', summaryStale: false, preferences: { nickname: '阿明', interests: ['爬山'] } });
  });

  it('再匯入一次：一樣的設定檔沿用，不會重複；沒有 key 的補上', async () => {
    const { chat } = await seed();
    await db.update(llmProfiles).set({ apiKeyEnc: null, apiKeyHint: null }).where(sql`id = ${chat.id}`);
    const file = (await inject<SettingsFile>('GET', '/api/settings/export')).body;
    file.profiles.find((p) => p.name === 'Gemini')!.apiKey = 'new-key-7890ab';
    const r = await inject<SettingsImportResultDto>('POST', '/api/settings/import', { file, include: { settings: true, profiles: true, player: false } });
    expect(r.body.profiles).toEqual({ created: 0, reused: 3, keys: 1 });
    expect((await db.select().from(llmProfiles)).length).toBe(3);
    const s = (await inject<AppSettings>('GET', '/api/settings')).body;
    expect(s.utilityLlm?.profileId).toBe(chat.id);
  });

  it('不匯入設定檔時，指向沒有的設定檔的地方清掉並提醒；格式錯誤整批拒絕', async () => {
    await seed();
    const file = (await inject<SettingsFile>('GET', '/api/settings/export')).body;
    await reset();
    const r = await inject<SettingsImportResultDto>('POST', '/api/settings/import', { file, include: { settings: true, profiles: false, player: false } });
    expect(r.body.profiles.created).toBe(0);
    expect(r.body.warnings).toEqual(expect.arrayContaining(['「系統工具模型」用的設定檔沒有匯入，請重新選擇', '「記憶」用的設定檔沒有匯入，請重新選擇']));
    const s = (await inject<AppSettings>('GET', '/api/settings')).body;
    expect(s.utilityLlm).toBeNull();
    expect(s.utilityByTask).toEqual({});
    expect(s.timezone).toBe('Asia/Tokyo');

    const bad = { ...file, profiles: [{ ...file.profiles[0]!, provider: 'openai-compatible', baseUrl: null }] };
    expect((await inject('POST', '/api/settings/import', { file: bad })).status).toBe(400);
    expect((await db.select().from(llmProfiles)).length).toBe(0);
    expect((await inject('POST', '/api/settings/import', { file: { format: 'x' } })).status).toBe(400);
  });
});
