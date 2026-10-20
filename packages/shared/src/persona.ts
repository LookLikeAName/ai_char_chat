// Avatar 的完整人格設定（avatar creator）。
//
// 同一份定義有三個用途：前端表單、驗證（包含 LLM 的輸出）、組給 LLM 的說明。
// 每個欄位都必填；玩家沒填的由系統工具模型補上。人格向度和玩家的心理測驗用同一套（Big Five、依附、Schwartz 價值）。
import { z } from 'zod';

// ---------- 選項 ----------

export const SCHWARTZ_VALUES = [
  'selfDirection',
  'stimulation',
  'hedonism',
  'achievement',
  'power',
  'security',
  'conformity',
  'tradition',
  'benevolence',
  'universalism',
] as const;
export type SchwartzValue = (typeof SCHWARTZ_VALUES)[number];

export const SCHWARTZ_LABELS: Record<SchwartzValue, string> = {
  selfDirection: '自主（獨立思考、自己做決定）',
  stimulation: '刺激（新鮮感、冒險）',
  hedonism: '享樂（享受生活、快樂）',
  achievement: '成就（成功、被肯定）',
  power: '權力（地位、掌控）',
  security: '安全（穩定、安全感）',
  conformity: '遵從（守規矩、不給人添麻煩）',
  tradition: '傳統（尊重習俗、家庭與信仰）',
  benevolence: '仁慈（照顧身邊的人）',
  universalism: '普世（公平、包容、關心世界）',
};

export const BIG_FIVE = ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism'] as const;
export type BigFiveTrait = (typeof BIG_FIVE)[number];
export const BIG_FIVE_LABELS: Record<BigFiveTrait, string> = {
  openness: '開放性',
  conscientiousness: '盡責性',
  extraversion: '外向性',
  agreeableness: '親和性',
  neuroticism: '神經質（情緒起伏）',
};

const options = <T extends string>(o: Record<T, string>) => o;

export const ENUM_OPTIONS = {
  emoji: options({ none: '幾乎不用', rare: '很少', some: '偶爾', lots: '很多' }),
  messageLength: options({ short: '很短', medium: '中等', long: '常常長篇大論' }),
  splitMessages: options({ rarely: '很少拆開', sometimes: '有時拆成幾則', often: '常常一句一則' }),
  typingSpeed: options({ slow: '慢', normal: '普通', fast: '快' }),
  attachment: options({
    secure: '安全型（自在、信任）',
    anxious: '焦慮型（需要確認、怕被冷落）',
    avoidant: '逃避型（重視距離、不太依賴人）',
    fearful: '恐懼逃避型（想靠近又怕受傷）',
  }),
  warmUpSpeed: options({ slow: '慢熱', medium: '普通', fast: '很快就熟' }),
  replyHabit: options({ instant: '秒回型', normal: '一般', slow: '常常很久才回' }),
  scheduleStatus: options({ free: '空閒', busy: '忙碌', sleep: '睡覺' }),
};

const keysOf = <T extends string>(o: Record<T, string>) => Object.keys(o) as [T, ...T[]];

// ---------- 欄位 schema ----------

const text = z.string().trim().min(1).max(200);
const long = z.string().trim().min(1).max(2000);
const list = z.array(z.string().trim().min(1).max(300)).min(1).max(20);
const scale = z.number().int().min(0).max(100);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '時間格式為 HH:MM');

export const scheduleBlockSchema = z.object({
  start: hhmm,
  end: hhmm,
  activity: z.string().trim().min(1).max(60),
  status: z.enum(keysOf(ENUM_OPTIONS.scheduleStatus)),
});
export type ScheduleBlock = z.infer<typeof scheduleBlockSchema>;

export const scheduleSchema = z.object({
  weekday: z.array(scheduleBlockSchema).min(1).max(16),
  weekend: z.array(scheduleBlockSchema).min(1).max(16),
});
export type Schedule = z.infer<typeof scheduleSchema>;

const bigFiveSchema = z.object({
  openness: scale,
  conscientiousness: scale,
  extraversion: scale,
  agreeableness: scale,
  neuroticism: scale,
});

const rankingSchema = z
  .array(z.enum(SCHWARTZ_VALUES))
  .length(SCHWARTZ_VALUES.length)
  .refine((a) => new Set(a).size === a.length, '每個價值只能出現一次');

export const personaSchema = z.object({
  basic: z.object({
    age: z.number().int().min(18, 'avatar 必須是成年人（18 歲以上）').max(120),
    gender: text,
    orientation: text,
    birthday: z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, '格式為 MM-DD'),
    appearance: long,
    style: text,
    occupation: text,
    location: text,
    family: long,
    upbringing: long,
    lifeEvents: list,
  }),
  speech: z.object({
    tone: text,
    vocabulary: text,
    catchphrases: list,
    emoji: z.enum(keysOf(ENUM_OPTIONS.emoji)),
    messageLength: z.enum(keysOf(ENUM_OPTIONS.messageLength)),
    splitMessages: z.enum(keysOf(ENUM_OPTIONS.splitMessages)),
    typingSpeed: z.enum(keysOf(ENUM_OPTIONS.typingSpeed)),
    punctuation: text,
    language: text,
    sampleLines: list,
  }),
  personality: z.object({
    bigFive: bigFiveSchema,
    attachment: z.enum(keysOf(ENUM_OPTIONS.attachment)),
    traits: list,
    humor: text,
    emotionalExpression: long,
  }),
  cognition: z.object({
    thinkingStyle: text,
    decisionMaking: text,
    stressResponse: long,
    conflictStyle: text,
    selfImage: long,
    innerConflict: long,
  }),
  values: z.object({
    ranking: rankingSchema,
    lifeGoals: long,
    shortTermGoals: list,
    fears: list,
    secrets: list,
    regrets: long,
  }),
  principles: z.object({
    moralLines: list,
    neverDo: list,
    attitudeToPeople: long,
    discretion: scale,
  }),
  preferences: z.object({
    likes: list,
    dislikes: list,
    hobbies: list,
    petPeeves: list,
    favoriteTopics: list,
  }),
  romance: z.object({
    loveAttitude: long,
    idealType: long,
    warmUpSpeed: z.enum(keysOf(ENUM_OPTIONS.warmUpSpeed)),
    affectionStyle: text,
    jealousy: scale,
    boundaries: list,
    pastRelationships: long,
  }),
  routine: z.object({
    schedule: scheduleSchema,
    replyHabit: z.enum(keysOf(ENUM_OPTIONS.replyHabit)),
    phoneHabit: text,
  }),
  relationship: z.object({
    withUser: long,
    callsUser: text,
  }),
});
export type Persona = z.infer<typeof personaSchema>;
export type PersonaSection = keyof Persona;

/** 編輯中的設定：任何欄位都可能還沒填 */
export type PersonaDraft = { [S in PersonaSection]?: { [F in keyof Persona[S]]?: Persona[S][F] } };

// ---------- 介面用的欄位說明 ----------

export type FieldType =
  | 'text'
  | 'long'
  | 'list'
  | 'number'
  | 'scale'
  | 'select'
  | 'bigFive'
  | 'ranking'
  | 'schedule';

export interface FieldMeta {
  label: string;
  type: FieldType;
  /** 介面提示，也會給 LLM 當說明 */
  hint?: string;
  /** select 的選項 */
  options?: Record<string, string>;
  /** scale 的兩端 */
  scaleLabels?: [string, string];
}

export interface SectionMeta {
  key: PersonaSection;
  label: string;
  fields: Record<string, FieldMeta>;
}

export const PERSONA_SECTIONS: SectionMeta[] = [
  {
    key: 'basic',
    label: '基本資料',
    fields: {
      age: { label: '年齡', type: 'number', hint: '18 歲以上' },
      gender: { label: '性別', type: 'text' },
      orientation: { label: '性傾向', type: 'text' },
      birthday: { label: '生日', type: 'text', hint: 'MM-DD，例如 03-14' },
      appearance: { label: '外貌', type: 'long', hint: '身高、體型、髮型、五官、給人的第一印象' },
      style: { label: '穿著風格', type: 'text' },
      occupation: { label: '職業', type: 'text' },
      location: { label: '居住地', type: 'text' },
      family: { label: '家庭背景', type: 'long' },
      upbringing: { label: '成長經歷', type: 'long' },
      lifeEvents: { label: '重要人生事件', type: 'list', hint: '影響他很深的幾件事' },
    },
  },
  {
    key: 'speech',
    label: '說話方式',
    fields: {
      tone: { label: '語氣', type: 'text', hint: '例如：溫柔、毒舌、慵懶、元氣' },
      vocabulary: { label: '用字習慣', type: 'text', hint: '例如：常用網路用語、講話文謅謅、夾雜英文' },
      catchphrases: { label: '口頭禪', type: 'list' },
      emoji: { label: 'emoji／貼圖', type: 'select', options: ENUM_OPTIONS.emoji },
      messageLength: { label: '訊息長度', type: 'select', options: ENUM_OPTIONS.messageLength },
      splitMessages: { label: '拆成多則', type: 'select', options: ENUM_OPTIONS.splitMessages },
      typingSpeed: { label: '打字速度', type: 'select', options: ENUM_OPTIONS.typingSpeed },
      punctuation: { label: '標點習慣', type: 'text', hint: '例如：不打標點、愛用～、句尾加「w」' },
      language: { label: '語言與方言', type: 'text', hint: '例如：繁體中文（台灣），偶爾夾台語' },
      sampleLines: { label: '說話範例', type: 'list', hint: '他會傳的幾句訊息，最能抓到語感' },
    },
  },
  {
    key: 'personality',
    label: '人格',
    fields: {
      bigFive: { label: '五大人格', type: 'bigFive', hint: '和玩家的心理測驗用同一套量表（0–100）' },
      attachment: { label: '依附風格', type: 'select', options: ENUM_OPTIONS.attachment },
      traits: { label: '性格關鍵字', type: 'list' },
      humor: { label: '幽默感', type: 'text' },
      emotionalExpression: { label: '情緒表現', type: 'long', hint: '開心、生氣、難過時分別會怎樣' },
    },
  },
  {
    key: 'cognition',
    label: '思考方式',
    fields: {
      thinkingStyle: { label: '思考風格', type: 'text', hint: '分析型或直覺型、想很多或很直接' },
      decisionMaking: { label: '做決定的方式', type: 'text' },
      stressResponse: { label: '面對壓力', type: 'long' },
      conflictStyle: { label: '面對衝突', type: 'text' },
      selfImage: { label: '自我認知', type: 'long', hint: '他怎麼看自己（不一定準確）' },
      innerConflict: { label: '內在矛盾', type: 'long', hint: '讓角色立體的地方' },
    },
  },
  {
    key: 'values',
    label: '價值觀與目標',
    fields: {
      ranking: { label: '價值排序', type: 'ranking', hint: 'Schwartz 基本價值，由最重要到最不重要' },
      lifeGoals: { label: '人生目標', type: 'long' },
      shortTermGoals: { label: '短期目標', type: 'list' },
      fears: { label: '恐懼', type: 'list' },
      secrets: { label: '秘密', type: 'list', hint: '不會輕易說出口的事' },
      regrets: { label: '遺憾', type: 'long' },
    },
  },
  {
    key: 'principles',
    label: '行為準則',
    fields: {
      moralLines: { label: '道德底線', type: 'list' },
      neverDo: { label: '絕對不會做的事', type: 'list' },
      attitudeToPeople: { label: '對人的基本態度', type: 'long' },
      discretion: {
        label: '口風',
        type: 'scale',
        scaleLabels: ['大嘴巴', '守口如瓶'],
        hint: '決定私下聽到的事會不會說出去',
      },
    },
  },
  {
    key: 'preferences',
    label: '好惡',
    fields: {
      likes: { label: '喜歡的東西', type: 'list' },
      dislikes: { label: '討厭的東西', type: 'list' },
      hobbies: { label: '興趣', type: 'list' },
      petPeeves: { label: '雷點', type: 'list', hint: '別人做了會讓他不爽的事' },
      favoriteTopics: { label: '喜歡聊的話題', type: 'list' },
    },
  },
  {
    key: 'romance',
    label: '感情觀',
    fields: {
      loveAttitude: { label: '對戀愛的態度', type: 'long' },
      idealType: { label: '喜歡的類型', type: 'long' },
      warmUpSpeed: { label: '升溫速度', type: 'select', options: ENUM_OPTIONS.warmUpSpeed },
      affectionStyle: { label: '表達愛意的方式', type: 'text' },
      jealousy: { label: '吃醋程度', type: 'scale', scaleLabels: ['幾乎不吃醋', '超會吃醋'] },
      boundaries: { label: '感情底線', type: 'list' },
      pastRelationships: { label: '過去的感情經歷', type: 'long' },
    },
  },
  {
    key: 'routine',
    label: '日常作息',
    fields: {
      schedule: { label: '每週作息', type: 'schedule', hint: '決定他什麼時候有空、多久才回訊息' },
      replyHabit: { label: '回訊息習慣', type: 'select', options: ENUM_OPTIONS.replyHabit },
      phoneHabit: { label: '手機使用習慣', type: 'text' },
    },
  },
  {
    key: 'relationship',
    label: '和你的關係',
    fields: {
      withUser: { label: '初始關係與認識經過', type: 'long', hint: '用「對方」指你，例如：對方是大學社團的學弟、對方是常來店裡的熟客' },
      callsUser: { label: '怎麼稱呼你', type: 'text' },
    },
  },
];

// ---------- 工具 ----------

/** 欄位路徑，例如 "basic.age" */
export type PersonaPath = string;

export const PERSONA_PATHS: PersonaPath[] = PERSONA_SECTIONS.flatMap((s) =>
  Object.keys(s.fields).map((f) => `${s.key}.${f}`),
);

export function fieldMeta(path: PersonaPath): FieldMeta | undefined {
  const [s, f] = path.split('.');
  return PERSONA_SECTIONS.find((x) => x.key === s)?.fields[f!];
}

export function fieldSchema(path: PersonaPath): z.ZodType | undefined {
  const [s, f] = path.split('.') as [PersonaSection, string];
  const section = personaSchema.shape[s] as z.ZodObject | undefined;
  return section?.shape[f] as z.ZodType | undefined;
}

export function getField(draft: PersonaDraft, path: PersonaPath): unknown {
  const [s, f] = path.split('.');
  return (draft as Record<string, Record<string, unknown> | undefined>)[s!]?.[f!];
}

export function setField(draft: PersonaDraft, path: PersonaPath, value: unknown): PersonaDraft {
  const [s, f] = path.split('.') as [string, string];
  const d = draft as Record<string, Record<string, unknown> | undefined>;
  const section = { ...(d[s] ?? {}) };
  if (value === undefined) delete section[f];
  else section[f] = value;
  return { ...d, [s]: section } as PersonaDraft;
}

/** 有值而且通過驗證 */
export function isFieldFilled(draft: PersonaDraft, path: PersonaPath): boolean {
  const v = getField(draft, path);
  if (v === undefined || v === null || v === '') return false;
  return fieldSchema(path)?.safeParse(v).success ?? false;
}

export function missingFields(draft: PersonaDraft): PersonaPath[] {
  return PERSONA_PATHS.filter((p) => !isFieldFilled(draft, p));
}

export function isPersonaEmpty(draft: PersonaDraft | null | undefined): boolean {
  return !draft || PERSONA_PATHS.every((p) => {
    const v = getField(draft, p);
    return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
  });
}

/** 只保留有值且合法的欄位；不合法的值回報在 errors */
export function sanitizeDraft(input: unknown): { draft: PersonaDraft; errors: Record<PersonaPath, string> } {
  let draft: PersonaDraft = {};
  const errors: Record<PersonaPath, string> = {};
  const src = (input && typeof input === 'object' ? input : {}) as PersonaDraft;
  for (const path of PERSONA_PATHS) {
    const v = getField(src, path);
    if (v === undefined || v === null || v === '') continue;
    const r = fieldSchema(path)!.safeParse(v);
    if (r.success) draft = setField(draft, path, r.data);
    else errors[path] = r.error.issues[0]?.message ?? '格式錯誤';
  }
  return { draft, errors };
}

/** 依作息表找出某個時間點在做什麼；跨午夜的區段（例如 23:00–07:00）也算 */
export function currentBlock(schedule: Schedule, weekend: boolean, hhmmNow: string): ScheduleBlock | null {
  const blocks = weekend ? schedule.weekend : schedule.weekday;
  const t = toMinutes(hhmmNow);
  for (const b of blocks) {
    const s = toMinutes(b.start);
    const e = toMinutes(b.end);
    if (s === e) continue;
    if (s < e ? t >= s && t < e : t >= s || t < e) return b;
  }
  return null;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
}
