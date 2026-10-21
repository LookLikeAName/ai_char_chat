import { describe, expect, it } from 'vitest';
import { appSettingsSchema, PERSONA_PATHS, REQUIRED_PATHS, setField, type PersonaDraft } from '@acc/shared';
import { renderPersona } from '../src/persona/describe.ts';
import { generatePersona } from '../src/persona/generate.ts';
import { checkPersona } from '../src/persona/check.ts';
import { buildSystemPrompt, localClock } from '../src/reply/prompt.ts';
import { SAMPLE_PERSONA } from './fixtures/persona.ts';

/** 最小的 CallContext 替身：resolveBinding 查得到一個設定檔，usage_log 寫入直接忽略 */
function fakeCtx(replies: string[], calls: string[]) {
  const profile = {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'u',
    provider: 'openai-compatible',
    baseUrl: 'http://llm.test/v1',
    model: 'util',
    apiKeyEnc: null,
    apiKeyHint: null,
    defaults: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const db = {
    select: () => ({ from: () => ({ where: async () => [profile] }) }),
    insert: () => ({ values: async () => undefined }),
  };
  const fetchFn = async (_u: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    calls.push(body.messages.at(-1).content);
    const content = replies.shift() ?? '{}';
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: {} }));
  };
  return { db: db as never, box: { decrypt: () => '' } as never, fetchFn: fetchFn as never };
}

const settings = appSettingsSchema.parse({ utilityLlm: { profileId: '00000000-0000-4000-8000-000000000001', params: {} } });

function fullDraftExcept(...omit: string[]): PersonaDraft {
  let d: PersonaDraft = structuredClone(SAMPLE_PERSONA);
  for (const p of omit) d = setField(d, p, undefined);
  return d;
}

describe('renderPersona', () => {
  it('列出各區塊的標籤與易讀的值', () => {
    const text = renderPersona(SAMPLE_PERSONA);
    expect(text).toContain('## 說話方式');
    expect(text).toContain('口頭禪：真假、你很煩欸');
    expect(text).toContain('emoji／貼圖：很少');
    expect(text).toContain('外向性 55（中等）');
    expect(text).toContain('1. 自主');
    expect(text).toContain('平日：00:30–07:30 睡覺（睡覺）');
  });
});

describe('回覆 prompt 使用完整人格', () => {
  it('帶入人格、和玩家的關係、稱呼，以及依作息推算的目前活動', () => {
    const prompt = buildSystemPrompt({
      avatar: { name: '小雨', bio: '咖啡店店長', persona: SAMPLE_PERSONA },
      settings: { timezone: 'Asia/Taipei', adultContent: false },
      history: [],
      now: new Date('2026-10-19T03:00:00Z'), // 週一 台北 11:00
    });
    expect(prompt).toContain('## 價值觀與目標');
    expect(prompt).toContain('對方是常來店裡的熟客');
    expect(prompt).toContain('你稱呼對方「老客人」');
    expect(prompt).toContain('你現在大概在：顧店（忙碌）');
  });

  it('帶入玩家的稱呼、摘要與不想談的話題，但不重複稱呼', () => {
    const prompt = buildSystemPrompt({
      avatar: { name: '小雨', bio: '咖啡店店長', persona: SAMPLE_PERSONA },
      user: {
        preferences: {
          nickname: '阿明',
          gender: '',
          ageRange: '25-34',
          lifeSituation: '工程師',
          interests: ['爬山'],
          chatStyles: ['banter'],
          avoidTopics: ['前任'],
          romance: 'slow',
          attractedTo: '',
          routine: '',
          about: '',
        },
        summary: '這位玩家慢熱但很真誠。',
        results: { bigFive: null, attachment: null, values: null },
      },
      // 成為朋友後才看得到摘要
      state: { relationship: { stage: 'friend', affinity: 35, trust: 35 }, mood: { label: '平常', valence: 0, energy: 0 }, memories: [], impression: null },
      settings: { timezone: 'Asia/Taipei', adultContent: false },
      history: [],
      now: new Date('2026-10-19T03:00:00Z'),
    });
    expect(prompt).toContain('對方的名字（希望被這樣稱呼）：阿明');
    expect(prompt).toContain('這位玩家慢熱但很真誠。');
    expect(prompt).toContain('- 興趣：爬山');
    expect(prompt).toContain('對方不想談：前任');
    expect(prompt).not.toContain('希望被稱呼為');
    expect(prompt).toContain('不要提到測驗');
  });

  it('人格不完整時只用簡介', () => {
    const prompt = buildSystemPrompt({
      avatar: { name: '小雨', bio: '咖啡店店長', persona: fullDraftExcept('basic.age') },
      settings: { timezone: 'Asia/Taipei', adultContent: false },
      history: [],
      now: new Date(),
    });
    expect(prompt).not.toContain('## 價值觀與目標');
    expect(prompt).toContain('認識不久');
  });

  it('localClock 依時區判斷週末與時間', () => {
    expect(localClock(new Date('2026-10-18T16:30:00Z'), 'Asia/Taipei')).toMatchObject({ weekend: false, hhmm: '00:30' }); // 週一凌晨
    expect(localClock(new Date('2026-10-18T03:05:00Z'), 'Asia/Taipei')).toMatchObject({ weekend: true, hhmm: '11:05' }); // 週日
  });
});

describe('generatePersona', () => {
  it('只產生缺少的欄位，已填的當作既定事實；名字與簡介沒填時一併產生', async () => {
    const calls: string[] = [];
    const ctx = fakeCtx(
      [JSON.stringify({ name: '林小雨', bio: '毒舌店長', persona: { 'basic.age': 29, speech: { emoji: 'lots' } } })],
      calls,
    );
    const res = await generatePersona(ctx, settings, {
      name: '',
      bio: '',
      persona: fullDraftExcept('basic.age', 'speech.emoji'),
      locks: [],
    });
    expect(res.filled.sort()).toEqual(['basic.age', 'speech.emoji']);
    expect(res.failed).toEqual([]);
    expect(res.name).toBe('林小雨');
    expect(res.bio).toBe('毒舌店長');
    expect(res.persona.basic?.age).toBe(29);
    expect(res.persona.speech?.emoji).toBe('lots');
    expect(calls[0]).toContain('- basic.age（年齡）');
    expect(calls[0]).toContain('"basic.occupation": "咖啡店店長"');
  });

  it('不合法的值會帶著錯誤原因重試一次，還是不行就回報失敗', async () => {
    const calls: string[] = [];
    const ctx = fakeCtx(
      [
        JSON.stringify({ persona: { 'basic.age': 16, 'speech.emoji': 'tons' } }),
        JSON.stringify({ persona: { 'basic.age': 21, 'speech.emoji': 'still-bad' } }),
      ],
      calls,
    );
    const res = await generatePersona(ctx, settings, {
      name: '小雨',
      bio: 'x',
      persona: fullDraftExcept('basic.age', 'speech.emoji'),
      locks: [],
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('上一次這些欄位的值不合法');
    expect(calls[1]).toContain('basic.age：avatar 必須是成年人');
    expect(res.persona.basic?.age).toBe(21);
    expect(res.failed).toEqual(['speech.emoji']);
  });

  it('重新產生時跳過鎖定的欄位，並要求寫出不同的新版本', async () => {
    const calls: string[] = [];
    const ctx = fakeCtx([JSON.stringify({ persona: { 'speech.tone': '慵懶' } })], calls);
    const res = await generatePersona(ctx, settings, {
      name: '小雨',
      bio: 'x',
      persona: structuredClone(SAMPLE_PERSONA),
      locks: ['speech.vocabulary'],
      only: ['speech.tone', 'speech.vocabulary'],
    });
    expect(res.filled).toEqual(['speech.tone']);
    expect(res.persona.speech?.vocabulary).toBe(SAMPLE_PERSONA.speech.vocabulary);
    expect(calls[0]).toContain('請寫出和原本不同的新版本');
    expect(calls[0]).not.toContain('- speech.vocabulary');
  });

  it('全空時產生所有欄位', async () => {
    const calls: string[] = [];
    const ctx = fakeCtx([JSON.stringify({ persona: SAMPLE_PERSONA })], calls);
    const res = await generatePersona(ctx, settings, { name: '小雨', bio: 'x', persona: {}, locks: [], seed: '毒舌店長' });
    // 沒開成人內容：「親密與性」不產生
    expect(res.filled).toHaveLength(REQUIRED_PATHS.length);
    expect(res.filled.some((p) => p.startsWith('intimacy.'))).toBe(false);
    expect(calls[0]).toContain('## 角色概念（玩家對這個角色的要求，描述的是角色本身，不是玩家）\n毒舌店長');
    expect(calls[0]).not.toContain('intimacy');
  });

  it('開了成人內容：也產生「親密與性」，並要求照角色概念如實寫', async () => {
    const calls: string[] = [];
    const intimacy = { openness: 90, style: '喜歡用文字調情，也喜歡主導', limits: ['不在公共場合', '不拍照'] };
    const ctx = fakeCtx([JSON.stringify({ persona: { ...SAMPLE_PERSONA, intimacy } })], calls);
    const adult = { ...settings, adultContent: true };
    const res = await generatePersona(ctx, adult, { name: '小雨', bio: 'x', persona: {}, locks: [], seed: '炮友' });
    expect(res.filled).toHaveLength(PERSONA_PATHS.length);
    expect(res.persona.intimacy).toEqual(intimacy);
    expect(calls[0]).toContain('intimacy.openness');
    expect(calls[0]).toContain('不要刻意淡化');
  });

  it('沒有設定系統工具模型時提示去設定', async () => {
    await expect(
      generatePersona(fakeCtx([], []), appSettingsSchema.parse({}), { name: '', bio: '', persona: {}, locks: [] }),
    ).rejects.toThrow(/系統工具模型/);
  });
});

describe('checkPersona', () => {
  it('過濾掉鎖定欄位與不合法的建議', async () => {
    const ctx = fakeCtx(
      [
        JSON.stringify({
          issues: [
            {
              fields: ['basic.occupation', 'personality.bigFive', 'not.a.field'],
              problem: '內向卻當店長',
              suggestion: { 'basic.occupation': '烘豆師', 'personality.bigFive': { openness: 999 }, 'speech.tone': '溫柔' },
            },
            { problem: '' },
          ],
        }),
      ],
      [],
    );
    const issues = await checkPersona(ctx, settings, {
      name: '小雨',
      bio: '',
      persona: SAMPLE_PERSONA as never,
      locks: ['speech.tone'],
    });
    expect(issues).toEqual([
      { fields: ['basic.occupation', 'personality.bigFive'], problem: '內向卻當店長', suggestion: { 'basic.occupation': '烘豆師' } },
    ]);
  });
});
