import { describe, expect, it } from 'vitest';
import { NEUTRAL_MOOD, preferencesSchema } from '@acc/shared';
import { ApiEmbedder } from '../src/memory/embedder.ts';
import { bigramSimilarity } from '../src/memory/store.ts';
import { parseReplyOutput } from '../src/reply/output.ts';
import { buildSystemPrompt, userSection } from '../src/reply/prompt.ts';
import type { FetchFn } from '../src/llm/index.ts';
import { SAMPLE_PERSONA } from './fixtures/persona.ts';

describe('parseReplyOutput：狀態欄位', () => {
  it('讀取心情、好感、信任與關係事件', () => {
    const out = parseReplyOutput(
      JSON.stringify({
        messages: ['嗯'],
        mood: { label: '害羞', valence: 3, energy: 1 },
        affinity_delta: 2,
        trust_delta: '1',
        relationship_event: { type: 'mutual_feelings', note: '他說喜歡我做的咖啡' },
      }),
    )!;
    expect(out).toMatchObject({
      mood: { label: '害羞', valence: 3, energy: 1 },
      affinityDelta: 2,
      trustDelta: 1,
      event: { type: 'mutual_feelings', note: '他說喜歡我做的咖啡' },
    });
  });
  it('狀態欄位不合法時忽略，不影響訊息', () => {
    const out = parseReplyOutput(
      JSON.stringify({ messages: ['嗯'], mood: { label: '', valence: 9 }, affinity_delta: 'a', relationship_event: 'marry' }),
    )!;
    expect(out).toMatchObject({ messages: ['嗯'], mood: undefined, affinityDelta: 0, event: null });
  });
});

describe('prompt：關係、心情、記憶', () => {
  const user = {
    preferences: {
      nickname: '阿明',
      gender: '',
      ageRange: null,
      lifeSituation: '',
      interests: ['爬山'],
      chatStyles: [],
      avoidTopics: [],
      romance: 'none' as const,
      attractedTo: '',
      routine: '',
      about: '',
    },
    summary: '這位玩家慢熱。',
    results: { bigFive: null, attachment: null, values: null },
  };

  it('依關係深淺逐步透露玩家的資料', () => {
    expect(userSection(user, 'stranger')).not.toContain('爬山');
    expect(userSection(user, 'acquaintance')).toContain('爬山');
    expect(userSection(user, 'acquaintance')).not.toContain('慢熱');
    expect(userSection(user, 'friend')).toContain('這位玩家慢熱。');
  });

  it('列出關係、心情、印象與記憶，並給出戀愛發展的提示', () => {
    const now = new Date('2026-10-19T12:00:00Z');
    const prompt = buildSystemPrompt({
      avatar: { name: '小雨', bio: '', persona: SAMPLE_PERSONA },
      user,
      state: {
        relationship: { stage: 'friend', affinity: 40, trust: 30 },
        mood: { label: '有點累', valence: -1, energy: -3 },
        memories: [{ content: '阿明說下週要去爬合歡山', createdAt: new Date('2026-10-16T12:00:00Z') }],
        impression: '他看起來很穩重。',
      },
      settings: { timezone: 'Asia/Taipei', adultContent: false },
      history: [],
      now,
    });
    expect(prompt).toContain('## 你們的關係：朋友（好感 40/100、信任 30/100）');
    expect(prompt).toContain('對方表示只想當朋友');
    expect(prompt).not.toContain('## 戀愛');
    expect(prompt).not.toContain('romance_delta');
    expect(prompt).toContain('## 你現在的心情：有點累');
    expect(prompt).toContain('他看起來很穩重。');
    expect(prompt).toContain('- 10/16（3 天前）：阿明說下週要去爬合歡山');
    expect(prompt).toContain('"affinity_delta": -3～3');
  });
});

describe('prompt：戀愛的部分數值夠才放出', () => {
  const user = (romance: 'none' | 'open' | null) => ({
    preferences: preferencesSchema.parse({ nickname: '阿明', gender: '男', attractedTo: '女生', romance }),
    summary: '',
    results: { bigFive: null, attachment: null, values: null },
  });
  const build = (relationship: object, romance: 'none' | 'open' | null = 'open', mode: 'reply' | 'proactive' = 'reply') =>
    buildSystemPrompt({
      avatar: { name: '小雨', bio: '', persona: SAMPLE_PERSONA },
      user: user(romance),
      state: { relationship: { stage: 'friend', affinity: 40, trust: 30, romance: 0, ...relationship } as never, mood: NEUTRAL_MOOD, memories: [], impression: null },
      situation: { mode },
      settings: { timezone: 'Asia/Taipei', adultContent: false },
      history: [],
      now: new Date('2026-10-19T04:00:00Z'),
    });

  it('好感太低時不放出，對方告白會覺得太突然', () => {
    const p = build({ affinity: 10 });
    expect(p).not.toContain('## 戀愛');
    expect(p).toContain('太突然');
    expect(p).not.toContain('mutual_feelings');
  });
  it('放出時附上心動、性傾向與對方的性別；可能的事件依關係列出', () => {
    const p = build({ affinity: 50, romance: 40 });
    expect(p).toContain('心動 40/100');
    expect(p).toContain(`你的性傾向：${SAMPLE_PERSONA.basic.orientation}`);
    expect(p).toContain('對方的性別：男');
    expect(p).toContain('對方喜歡的對象：女生');
    expect(p).toContain('mutual_feelings（彼此有了好感');
    expect(p).not.toContain('avatar_confessed');
  });
  it('曖昧中主動發話會帶戀愛話題；戀人可以分手、前任可以復合', () => {
    expect(build({ stage: 'crush', affinity: 60, trust: 50, romance: 50 }, 'open', 'proactive')).toContain('約對方出去');
    expect(build({ stage: 'lover', affinity: 70, trust: 60, romance: 70 })).toContain('breakup（分手）');
    expect(build({ stage: 'ex', affinity: 30, trust: 30, romance: 40 })).toContain('got_back_together');
  });
});

describe('bigramSimilarity', () => {
  it('中文以雙連詞比較', () => {
    expect(bigramSimilarity('下週要去面試', '面試準備得怎樣')).toBeGreaterThan(0);
    expect(bigramSimilarity('下週要去面試', '今天天氣很好')).toBe(0);
  });
});

describe('ApiEmbedder', () => {
  function fake(response: unknown) {
    const calls: { url: string; body: any }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify(response));
    }) as unknown as FetchFn;
    return { fetchFn, calls };
  }
  const vec = (x: number) => Array.from({ length: 768 }, (_, i) => (i === 0 ? x : 0));

  it('Gemini：指定 768 維與任務類型，結果正規化', async () => {
    const { fetchFn, calls } = fake({ embeddings: [{ values: vec(3) }] });
    const e = new ApiEmbedder({ provider: 'google', baseUrl: 'https://g.test/v1beta', model: 'gemini-embedding-001', apiKey: 'k' }, fetchFn);
    const [v] = await e.embed(['嗨'], 'query');
    expect(v![0]).toBeCloseTo(1);
    expect(calls[0]!.url).toBe('https://g.test/v1beta/models/gemini-embedding-001:batchEmbedContents');
    expect(calls[0]!.body.requests[0]).toMatchObject({ taskType: 'RETRIEVAL_QUERY', outputDimensionality: 768 });
  });

  it('gemini-embedding-2：不送 taskType（會被忽略），把查詢／文件寫在文字前面', async () => {
    const { fetchFn, calls } = fake({ embeddings: [{ values: vec(1) }, { values: vec(2) }] });
    const e = new ApiEmbedder({ provider: 'google', baseUrl: 'https://g.test/v1beta', model: 'gemini-embedding-2', apiKey: 'k' }, fetchFn);
    await e.embed(['對方在準備面試', '他養了貓'], 'document');
    await e.embed(['面試'], 'query').catch(() => {});
    const [doc] = calls[0]!.body.requests;
    expect(doc).toEqual({
      model: 'models/gemini-embedding-2',
      content: { parts: [{ text: 'title: none | text: 對方在準備面試' }] },
      outputDimensionality: 768,
    });
    expect(calls[1]!.body.requests[0].content.parts[0].text).toBe('task: search result | query: 面試');
    expect(calls[1]!.body.requests[0]).not.toHaveProperty('taskType');
  });

  it('OpenAI 相容：依 index 排序，維度不符時報錯', async () => {
    const { fetchFn, calls } = fake({ data: [{ index: 1, embedding: vec(1) }, { index: 0, embedding: vec(2) }] });
    const e = new ApiEmbedder({ provider: 'openai-compatible', baseUrl: 'http://x/v1', model: 'm' }, fetchFn);
    expect(await e.embed(['a', 'b'], 'document')).toHaveLength(2);
    expect(calls[0]!.body).toMatchObject({ model: 'm', input: ['a', 'b'], dimensions: 768 });
    const bad = fake({ data: [{ index: 0, embedding: [1, 2, 3] }] });
    await expect(new ApiEmbedder({ provider: 'openai', baseUrl: 'http://x/v1', model: 'm' }, bad.fetchFn).embed(['a'], 'query')).rejects.toThrow(/768/);
  });
});
