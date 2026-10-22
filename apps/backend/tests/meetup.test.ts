// 見面模式：prompt、輸出解析、API 與回覆流程（TEST_DATABASE_URL 沒設定時略過 DB 的部分）
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ConversationDto, MeetupDto, MessageDto, ServerEvent } from '@acc/shared';
import { buildApp } from '../src/app.ts';
import { SecretBox } from '../src/crypto.ts';
import { createDb, runMigrations } from '../src/db/client.ts';
import { avatars, conversationMembers, conversations, llmProfiles, meetups, messages } from '../src/db/schema.ts';
import type { AgentJob } from '../src/jobs.ts';
import type { FetchFn } from '../src/llm/index.ts';
import { MemoryLock } from '../src/lock.ts';
import { ReplyEngine } from '../src/reply/engine.ts';
import { parseReplyOutput } from '../src/reply/output.ts';
import { buildReplyPrompt } from '../src/reply/prompt.ts';
import { WsHub } from '../src/ws.ts';

const now = new Date('2026-10-19T12:00:00Z');
const at = (min: number) => new Date(now.getTime() + min * 60_000);
const base = { avatar: { name: '小雨', bio: '咖啡店店長', persona: {} }, settings: { timezone: 'Asia/Taipei', adultContent: false }, now };
const meetup = { id: 'm1', place: '河堤邊的咖啡廳', note: '第一次約出來', startedAt: at(-30) };

describe('見面的 prompt', () => {
  it('面對面：地點、見了多久、旁白與台詞的格式，不提傳訊息與照片', () => {
    const { system } = buildReplyPrompt({
      ...base,
      situation: { mode: 'meetup', meetup },
      history: [],
      photos: { remaining: 3 },
    });
    expect(system).toContain('現在你們面對面在「河堤邊的咖啡廳」');
    expect(system).toContain('已經見面 30 分鐘了');
    expect(system).toContain('（第一次約出來）');
    expect(system).toContain('"beats"');
    expect(system).toContain('leave');
    expect(system).toContain('不要替對方決定');
    expect(system).not.toContain('像真人傳訊息');
    expect(system).not.toContain('"photo"');
  });

  it('剛碰面：由 avatar 先開口', () => {
    const { system, messages } = buildReplyPrompt({ ...base, situation: { mode: 'meetup', meetup: { ...meetup, opening: true } }, history: [], meetups: [meetup] });
    expect(system).toContain('剛剛碰面');
    expect(system).toContain('由你先開口');
    // 紀錄最後補上「現在面對面了」，最後一個回合是 user
    expect(messages.at(-1)).toMatchObject({ role: 'user' });
    expect(String(messages.at(-1)!.content)).toContain('約在「河堤邊的咖啡廳」見面，現在面對面了');
  });

  it('紀錄：見面時說的話標出動作與台詞，自己的寫成 beats；見面結束後回到傳訊息', () => {
    const { messages } = buildReplyPrompt({
      ...base,
      situation: { mode: 'reply' },
      meetups: [meetup],
      history: [
        { senderType: 'user', content: '那就約明天下午？', createdAt: at(-60) },
        { senderType: 'avatar', content: '好啊', createdAt: at(-59) },
        { senderType: 'user', content: '嗨', narration: '揮了揮手', meetupId: 'm1', createdAt: at(-30) },
        { senderType: 'avatar', content: '你好早到', narration: '小雨推開門，愣了一下才笑出來', meetupId: 'm1', createdAt: at(-29) },
        { senderType: 'user', content: '到家了嗎', createdAt: at(-1) },
      ],
    });
    const text = messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    expect(text).toContain('（系統：你們約在「河堤邊的咖啡廳」見面，現在面對面了。）');
    expect(text).toContain('【揮了揮手】「嗨」');
    expect(text).toContain('（系統：見面結束，你們各自離開了。之後又回到用手機傳訊息。）');
    const beats = messages.find((m) => m.role === 'assistant' && String(m.content).includes('beats'));
    expect(JSON.parse(String(beats!.content))).toEqual({ beats: [{ narration: '小雨推開門，愣了一下才笑出來', say: '你好早到' }] });
    expect(messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('到家了嗎') });
  });

  it('解析：beats 轉成台詞；只有旁白也算；leave', () => {
    const out = parseReplyOutput(
      JSON.stringify({ inner_thought: '好緊張', beats: [{ narration: '她低頭攪著咖啡', say: '' }, { action: '抬起頭', speech: '其實我也很期待' }], leave: true }),
    );
    expect(out).toMatchObject({
      messages: ['其實我也很期待'],
      beats: [
        { narration: '她低頭攪著咖啡', say: '' },
        { narration: '抬起頭', say: '其實我也很期待' },
      ],
      leave: true,
    });
    expect(parseReplyOutput(JSON.stringify({ beats: [{ narration: '笑了笑' }] }))?.beats).toHaveLength(1);
    expect(parseReplyOutput(JSON.stringify({ messages: ['嗨'] }))).toMatchObject({ beats: [], leave: false });
  });
});

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('見面', () => {
  const { db, pool } = createDb(url ?? '');
  const box = new SecretBox('test-secret-0123456789');
  const mediaDir = mkdtempSync(path.join(tmpdir(), 'acc-media-'));
  const events: ServerEvent[] = [];
  const jobs: AgentJob[] = [];
  let app: FastifyInstance;
  let responses: string[];
  let llmBodies: any[];
  let sleeps: number[];
  let conversationId: string;
  let avatarId: string;

  const fetchFn = (async (_u: string, init: RequestInit) => {
    llmBodies.push(JSON.parse(init.body as string));
    const content = responses.shift();
    if (content === undefined) return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 });
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  }) as unknown as FetchFn;

  const engine = () =>
    new ReplyEngine({
      db,
      box,
      events: { publish: async (e) => void events.push(e) },
      lock: new MemoryLock(),
      fetchFn,
      sleep: async (ms) => void sleeps.push(ms),
      random: () => 0.5,
      onMeetupEnded: async (a, c) => void jobs.push({ kind: 'memory.extract', avatarId: a, conversationId: c, force: true }),
    });
  const inject = async <T>(method: 'GET' | 'POST', u: string, payload?: unknown) => {
    const res = await app.inject({ method, url: u, payload: payload as never });
    return { status: res.statusCode, body: res.json() as T };
  };
  const beats = (...b: [string, string][]) => JSON.stringify({ inner_thought: '心跳好快', beats: b.map(([narration, say]) => ({ narration, say })) });
  const rows = () => db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt), asc(messages.seq));

  beforeAll(async () => {
    await runMigrations(db);
    app = await buildApp({
      db,
      box,
      events: { publish: async (e) => void events.push(e) },
      jobs: { add: async (j) => void jobs.push(j) },
      hub: new WsHub(),
      mediaDir,
    });
  });

  beforeEach(async () => {
    await db.execute(sql`truncate settings, llm_profiles, avatars, conversations, conversation_members, messages, usage_log, user_profile cascade`);
    events.length = 0;
    jobs.length = 0;
    responses = [];
    llmBodies = [];
    sleeps = [];
    const [p] = await db.insert(llmProfiles).values({ name: 't', provider: 'openai-compatible', baseUrl: 'http://llm.test/v1', model: 'm' }).returning();
    const [a] = await db.insert(avatars).values({ name: '小雨', bio: '咖啡店店長', llm: { profileId: p!.id, params: {} } }).returning();
    const [c] = await db.insert(conversations).values({ type: 'dm' }).returning();
    await db.insert(conversationMembers).values({ conversationId: c!.id, avatarId: a!.id });
    conversationId = c!.id;
    avatarId = a!.id;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    rmSync(mediaDir, { recursive: true, force: true });
  });

  it('沒寫開場：avatar 先開口，一段一段帶旁白送出，不用打字的時間', async () => {
    const start = await inject<MeetupDto>('POST', `/api/conversations/${conversationId}/meetup`, { place: '河堤邊的咖啡廳' });
    expect(start.status).toBe(201);
    expect(jobs).toEqual([{ kind: 'meetup.open', conversationId }]);
    const list = (await inject<ConversationDto[]>('GET', '/api/conversations')).body;
    expect(list[0]!.meetup).toMatchObject({ place: '河堤邊的咖啡廳', endedAt: null });
    // 同時只能有一場
    expect((await inject('POST', `/api/conversations/${conversationId}/meetup`, { place: '別的地方' })).status).toBe(409);

    responses = [beats(['小雨從門口探頭，看到你就揮了揮手', '這裡這裡！'], ['她拉開椅子坐下', '你等很久了嗎？'])];
    expect(await engine().handleMeetupOpen(conversationId)).toBe('sent');
    const msgs = await rows();
    expect(msgs.map((m) => [m.senderType, m.content, m.meta.narration ?? null])).toEqual([
      ['system', '你們約在河堤邊的咖啡廳見面', null],
      ['avatar', '這裡這裡！', '小雨從門口探頭，看到你就揮了揮手'],
      ['avatar', '你等很久了嗎？', '她拉開椅子坐下'],
    ]);
    expect(msgs.slice(1).every((m) => m.meta.meetupId === start.body.id)).toBe(true);
    // 只有段落之間的停頓（沒有讀訊息、打字的等待）
    expect(sleeps).toHaveLength(1);
    expect(llmBodies[0].messages[0].content).toContain('由你先開口');
    // 已經開口了：重複的工作不會再說一次
    expect(await engine().handleMeetupOpen(conversationId)).toBe('skipped');
  });

  it('玩家的動作與台詞：馬上排回覆；avatar 說要走就結束見面並整理記憶', async () => {
    await inject('POST', `/api/conversations/${conversationId}/meetup`, { place: '夜市', opening: '提早到了，在入口等她' });
    const [opening] = (await rows()).filter((m) => m.senderType === 'user');
    expect(opening!.meta.narration).toBe('提早到了，在入口等她');
    expect(jobs.at(-1)).toEqual({ kind: 'reply', conversationId });
    const [member] = await db.select().from(conversationMembers).where(eq(conversationMembers.conversationId, conversationId));
    expect(member!.replyDueAt).not.toBeNull();

    responses = [beats(['小雨小跑步過來', '抱歉抱歉！'])];
    expect(await engine().handle(conversationId)).toBe('done');
    const sent = await inject<MessageDto>('POST', `/api/conversations/${conversationId}/messages`, { action: '遞給她一杯珍奶', content: '請你的' });
    expect(sent.body).toMatchObject({ content: '請你的', narration: '遞給她一杯珍奶', meetupId: expect.any(String) });
    expect(llmBodies[0].messages.at(-1).content).toContain('【提早到了，在入口等她】');

    responses = [JSON.stringify({ beats: [{ narration: '她看了一下手機', say: '啊，我得回家了，今天謝謝你！' }], leave: true })];
    expect(await engine().handle(conversationId)).toBe('done');
    expect(llmBodies[1].messages.at(-1).content).toContain('【遞給她一杯珍奶】「請你的」');
    const [m] = await db.select().from(meetups);
    expect(m).toMatchObject({ endedBy: 'avatar' });
    expect(m!.endedAt).not.toBeNull();
    expect((await rows()).at(-1)).toMatchObject({ senderType: 'system', content: expect.stringContaining('小雨先離開了') });
    expect(jobs.at(-1)).toEqual({ kind: 'memory.extract', avatarId, conversationId, force: true });

    // 見面結束後：動作寫進訊息裡，回到一般的節奏
    const after = await inject<MessageDto>('POST', `/api/conversations/${conversationId}/messages`, { action: '傳了個貼圖', content: '到家說一聲' });
    expect(after.body).toMatchObject({ content: '（傳了個貼圖）到家說一聲', meetupId: null });
  });

  it('玩家結束見面；見面中不會主動傳訊息', async () => {
    await inject('POST', `/api/conversations/${conversationId}/meetup`, { place: '公園' });
    expect(await engine().handleProactive(conversationId)).toBe('skipped');
    const end = await inject<MeetupDto>('POST', `/api/conversations/${conversationId}/meetup/end`);
    expect(end.body).toMatchObject({ endedBy: 'user' });
    expect(jobs.at(-1)).toEqual({ kind: 'memory.extract', avatarId, conversationId, force: true });
    expect((await inject('POST', `/api/conversations/${conversationId}/meetup/end`)).status).toBe(409);
    expect((await inject<ConversationDto[]>('GET', '/api/conversations')).body[0]!.meetup).toBeNull();
  });

  it('群組不能見面', async () => {
    const [g] = await db.insert(conversations).values({ type: 'group', title: '群' }).returning();
    expect((await inject('POST', `/api/conversations/${g!.id}/meetup`, { place: '公園' })).status).toBe(400);
  });
});
