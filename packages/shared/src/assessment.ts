// 玩家的心理測驗：題庫與計分（純函式，前後端共用）。
//
// - Mini-IPIP：五大人格，20 題（Donnellan, Oswald, Baird & Lucas, 2006；IPIP 題目為公有領域）
// - ECR-RS：成人依附（焦慮、逃避），戀愛關係版 9 題（Fraley, Heffernan, Vicary & Brumbaugh, 2011）
// - PVQ-21：Schwartz 基本價值，21 題（European Social Survey 版）
//
// 中文題目是本專案自行翻譯，不是經過驗證的中文版；結果只當作 avatar 的參考，不是診斷。
import { z } from 'zod';
import { BIG_FIVE, type BigFiveTrait, SCHWARTZ_VALUES, type SchwartzValue } from './persona.ts';

export const INSTRUMENT_IDS = ['bigFive', 'attachment', 'values'] as const;
export type InstrumentId = (typeof INSTRUMENT_IDS)[number];

export interface Item {
  id: string;
  text: string;
  reverse?: boolean;
  /** 計入哪個向度 */
  dim: string;
}

export interface Instrument {
  id: InstrumentId;
  title: string;
  /** 測量什麼、出處 */
  about: string;
  citation: string;
  instructions: string;
  scale: { min: number; max: number; labels: string[] };
  items: Item[];
}

const ipip = (id: number, text: string, dim: BigFiveTrait, reverse = false): Item => ({ id: `ipip${id}`, text, dim, reverse });

export const BIG_FIVE_TEST: Instrument = {
  id: 'bigFive',
  title: '五大人格',
  about: '外向性、親和性、盡責性、神經質（情緒起伏）、開放性。人格心理學最廣泛使用的模型。',
  citation: 'Mini-IPIP（Donnellan et al., 2006）',
  instructions: '描述你「平常」的樣子，而不是你希望自己成為的樣子。和同年齡、同性別的人相比，下面的描述有多符合你？',
  scale: { min: 1, max: 5, labels: ['非常不符合', '不太符合', '說不上來', '有點符合', '非常符合'] },
  items: [
    ipip(1, '我是聚會中的靈魂人物。', 'extraversion'),
    ipip(2, '我能體會別人的感受。', 'agreeableness'),
    ipip(3, '該做的雜事我會馬上做完。', 'conscientiousness'),
    ipip(4, '我的情緒常常起伏不定。', 'neuroticism'),
    ipip(5, '我的想像力很豐富。', 'openness'),
    ipip(6, '我話不多。', 'extraversion', true),
    ipip(7, '我對別人的煩惱不感興趣。', 'agreeableness', true),
    ipip(8, '我常常忘記把東西放回原位。', 'conscientiousness', true),
    ipip(9, '我大部分時候都很放鬆。', 'neuroticism', true),
    ipip(10, '我對抽象的概念沒興趣。', 'openness', true),
    ipip(11, '在聚會上，我會跟很多不同的人聊天。', 'extraversion'),
    ipip(12, '我感受得到別人的情緒。', 'agreeableness'),
    ipip(13, '我喜歡井然有序。', 'conscientiousness'),
    ipip(14, '我很容易心煩。', 'neuroticism'),
    ipip(15, '我很難理解抽象的概念。', 'openness', true),
    ipip(16, '我習慣待在不起眼的位置，不出風頭。', 'extraversion', true),
    ipip(17, '我其實對別人不太感興趣。', 'agreeableness', true),
    ipip(18, '我常把事情搞得一團亂。', 'conscientiousness', true),
    ipip(19, '我很少感到憂鬱。', 'neuroticism', true),
    ipip(20, '我的想像力不太好。', 'openness', true),
  ],
};

const ecr = (id: number, text: string, dim: 'anxiety' | 'avoidance', reverse = false): Item => ({
  id: `ecr${id}`,
  text,
  dim,
  reverse,
});

export const ATTACHMENT_TEST: Instrument = {
  id: 'attachment',
  title: '依附風格',
  about: '在親密關係中的兩個向度：依附焦慮（擔心被拋棄、需要確認）與依附逃避（不習慣依賴與親近）。',
  citation: 'ECR-RS 戀愛關係版（Fraley et al., 2011）',
  instructions:
    '想著你目前、或過去最重要的一段戀愛關係中的對象；如果沒有戀愛經驗，就想像一位和你非常親近的人。你有多同意下面的描述？',
  scale: { min: 1, max: 7, labels: ['非常不同意', '不同意', '有點不同意', '普通', '有點同意', '同意', '非常同意'] },
  items: [
    ecr(1, '需要幫忙的時候，向對方求助對我很有幫助。', 'avoidance', true),
    ecr(2, '我通常會跟對方討論我的問題和煩惱。', 'avoidance', true),
    ecr(3, '有事情的時候，我會跟對方好好談開。', 'avoidance', true),
    ecr(4, '我覺得依賴對方是很自然、很容易的事。', 'avoidance', true),
    ecr(5, '對這個人敞開心房讓我覺得不自在。', 'avoidance'),
    ecr(6, '我不太想讓對方知道我內心深處的感受。', 'avoidance'),
    ecr(7, '我常常擔心對方其實並不在乎我。', 'anxiety'),
    ecr(8, '我害怕對方可能會離開我。', 'anxiety'),
    ecr(9, '我擔心對方在乎我的程度，比不上我在乎對方的程度。', 'anxiety'),
  ],
};

const pvq = (id: number, text: string, dim: SchwartzValue): Item => ({ id: `pvq${id}`, text, dim });

export const VALUES_TEST: Instrument = {
  id: 'values',
  title: '價值觀',
  about: '10 種基本價值的相對重要性：自主、刺激、享樂、成就、權力、安全、遵從、傳統、仁慈、普世。',
  citation: 'PVQ-21（Schwartz；European Social Survey 版）',
  instructions: '下面描述一些不同的人。讀完每一段，想想這個人跟你有多像？',
  scale: { min: 1, max: 6, labels: ['完全不像我', '不像我', '只有一點像我', '有點像我', '像我', '非常像我'] },
  items: [
    pvq(1, '對這個人來說，想出新點子、發揮創意很重要；喜歡用自己獨特的方式做事。', 'selfDirection'),
    pvq(2, '對這個人來說，變得富有很重要；想要有很多錢和昂貴的東西。', 'power'),
    pvq(3, '這個人認為世界上每個人都應該被平等對待，每個人在人生中都應該有平等的機會。', 'universalism'),
    pvq(4, '對這個人來說，展現自己的能力很重要；希望別人欣賞自己做的事。', 'achievement'),
    pvq(5, '對這個人來說，住在安全的環境裡很重要；會避開任何可能危及安全的事。', 'security'),
    pvq(6, '這個人喜歡驚喜，總是在找新鮮事做；認為人生中做很多不同的事很重要。', 'stimulation'),
    pvq(7, '這個人認為人應該照別人說的去做；任何時候都應該遵守規則，即使沒有人在看。', 'conformity'),
    pvq(8, '對這個人來說，聆聽和自己不同的人的想法很重要；即使意見不同，仍然想去理解對方。', 'universalism'),
    pvq(9, '對這個人來說，謙虛低調很重要；盡量不引人注目。', 'tradition'),
    pvq(10, '對這個人來說，玩得開心很重要；喜歡好好寵愛自己。', 'hedonism'),
    pvq(11, '對這個人來說，自己決定要做什麼很重要；喜歡自由、不依賴別人。', 'selfDirection'),
    pvq(12, '對這個人來說，幫助身邊的人非常重要；想要照顧他們過得好不好。', 'benevolence'),
    pvq(13, '對這個人來說，非常成功很重要；希望別人認可自己的成就。', 'achievement'),
    pvq(14, '對這個人來說，政府確保自己不受任何威脅很重要；希望國家強大，能保護人民。', 'security'),
    pvq(15, '這個人喜歡冒險、願意承擔風險；想要過刺激的生活。', 'stimulation'),
    pvq(16, '對這個人來說，隨時舉止得體很重要；想避免做任何別人會認為是錯的事。', 'conformity'),
    pvq(17, '對這個人來說，得到別人的尊重很重要；希望別人照自己說的去做。', 'power'),
    pvq(18, '對這個人來說，對朋友忠誠很重要；願意為親近的人付出。', 'benevolence'),
    pvq(19, '這個人深信人們應該愛護自然；照顧環境對這個人很重要。', 'universalism'),
    pvq(20, '傳統對這個人很重要；會盡量遵循宗教或家族傳下來的習俗。', 'tradition'),
    pvq(21, '這個人把握每個享樂的機會；做讓自己開心的事對這個人很重要。', 'hedonism'),
  ],
};

export const INSTRUMENTS: Record<InstrumentId, Instrument> = {
  bigFive: BIG_FIVE_TEST,
  attachment: ATTACHMENT_TEST,
  values: VALUES_TEST,
};

/** 作答：題號 → 選項分數 */
export type Answers = Record<string, number>;
export type AllAnswers = Partial<Record<InstrumentId, Answers>>;

export const answersPatchSchema = z.object({
  instrument: z.enum(INSTRUMENT_IDS),
  answers: z.record(z.string(), z.number().int().nullable()),
});

/** 只保留這份量表的題目、範圍內的整數 */
export function cleanAnswers(id: InstrumentId, answers: Record<string, unknown>): Answers {
  const inst = INSTRUMENTS[id];
  const ids = new Set(inst.items.map((i) => i.id));
  const out: Answers = {};
  for (const [k, v] of Object.entries(answers)) {
    if (ids.has(k) && Number.isInteger(v) && (v as number) >= inst.scale.min && (v as number) <= inst.scale.max) {
      out[k] = v as number;
    }
  }
  return out;
}

export function progress(id: InstrumentId, answers: Answers | undefined): { answered: number; total: number } {
  const items = INSTRUMENTS[id].items;
  return { answered: items.filter((i) => answers?.[i.id] !== undefined).length, total: items.length };
}

function itemScore(inst: Instrument, item: Item, raw: number): number {
  return item.reverse ? inst.scale.max + inst.scale.min - raw : raw;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const round1 = (x: number) => Math.round(x * 10) / 10;

/** 所有題目都答完才計分，否則回傳 null */
function dimensionMeans(inst: Instrument, answers: Answers | undefined): Record<string, number> | null {
  if (!answers || inst.items.some((i) => answers[i.id] === undefined)) return null;
  const by: Record<string, number[]> = {};
  for (const item of inst.items) (by[item.dim] ??= []).push(itemScore(inst, item, answers[item.id]!));
  return Object.fromEntries(Object.entries(by).map(([k, xs]) => [k, mean(xs)]));
}

export interface BigFiveResult {
  /** 1～5 的平均 */
  means: Record<BigFiveTrait, number>;
  /** 換算成 0～100，和 avatar 的人格設定同一個尺度 */
  scores: Record<BigFiveTrait, number>;
}

export function scoreBigFive(answers: Answers | undefined): BigFiveResult | null {
  const m = dimensionMeans(BIG_FIVE_TEST, answers);
  if (!m) return null;
  const means = Object.fromEntries(BIG_FIVE.map((t) => [t, round1(m[t]!)])) as Record<BigFiveTrait, number>;
  const scores = Object.fromEntries(BIG_FIVE.map((t) => [t, Math.round(((m[t]! - 1) / 4) * 100)])) as Record<
    BigFiveTrait,
    number
  >;
  return { means, scores };
}

export type AttachmentStyle = 'secure' | 'anxious' | 'avoidant' | 'fearful';

export interface AttachmentResult {
  /** 1～7 的平均 */
  anxiety: number;
  avoidance: number;
  /**
   * 以量表中點（4）切分的四種類型。量表本身是連續向度，類型只是方便描述的粗略分類。
   */
  style: AttachmentStyle;
}

export function scoreAttachment(answers: Answers | undefined): AttachmentResult | null {
  const m = dimensionMeans(ATTACHMENT_TEST, answers);
  if (!m) return null;
  const anxiety = round1(m.anxiety!);
  const avoidance = round1(m.avoidance!);
  const hiAnx = anxiety > 4;
  const hiAvo = avoidance > 4;
  const style: AttachmentStyle = hiAnx ? (hiAvo ? 'fearful' : 'anxious') : hiAvo ? 'avoidant' : 'secure';
  return { anxiety, avoidance, style };
}

export interface ValuesResult {
  /** 每個價值的平均（1～6） */
  means: Record<SchwartzValue, number>;
  /** 扣掉個人全部題目平均後的分數（Schwartz 建議的校正，消除每個人作答傾向的差異） */
  centered: Record<SchwartzValue, number>;
  /** 由最重要到最不重要 */
  ranking: SchwartzValue[];
}

export function scoreValues(answers: Answers | undefined): ValuesResult | null {
  const m = dimensionMeans(VALUES_TEST, answers);
  if (!m) return null;
  const overall = mean(VALUES_TEST.items.map((i) => answers![i.id]!));
  const means = Object.fromEntries(SCHWARTZ_VALUES.map((v) => [v, round1(m[v]!)])) as Record<SchwartzValue, number>;
  const centered = Object.fromEntries(SCHWARTZ_VALUES.map((v) => [v, round1(m[v]! - overall)])) as Record<
    SchwartzValue,
    number
  >;
  // 同分時依 SCHWARTZ_VALUES 的順序，結果才穩定
  const ranking = [...SCHWARTZ_VALUES].sort((a, b) => m[b]! - m[a]!);
  return { means, centered, ranking };
}

export interface AssessmentResults {
  bigFive: BigFiveResult | null;
  attachment: AttachmentResult | null;
  values: ValuesResult | null;
}

export function scoreAll(answers: AllAnswers): AssessmentResults {
  return {
    bigFive: scoreBigFive(answers.bigFive),
    attachment: scoreAttachment(answers.attachment),
    values: scoreValues(answers.values),
  };
}

// ---------- 偏好問卷 ----------

export const CHAT_STYLES = {
  casual: '輕鬆閒聊',
  deep: '深度談心',
  banter: '互相吐槽',
  sweet: '撒嬌、黏人',
  rational: '理性討論',
  playful: '搞笑、玩梗',
} as const;

export const ROMANCE_PREFS = {
  none: '只想當朋友',
  slow: '慢慢來，順其自然',
  open: '對戀愛很開放',
  eager: '希望積極發展',
} as const;

export const AGE_RANGES = { '18-24': '18–24 歲', '25-34': '25–34 歲', '35-44': '35–44 歲', '45+': '45 歲以上' } as const;

const keys = <T extends Record<string, string>>(o: T) => Object.keys(o) as [keyof T & string, ...(keyof T & string)[]];
const shortText = z.string().trim().max(200);

export const preferencesSchema = z.object({
  /** 唯一必填：希望 avatar 怎麼稱呼你 */
  nickname: z.string().trim().min(1, '請填寫稱呼').max(40),
  gender: shortText.default(''),
  ageRange: z.enum(keys(AGE_RANGES)).nullable().default(null),
  lifeSituation: shortText.default(''),
  interests: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  chatStyles: z.array(z.enum(keys(CHAT_STYLES))).max(6).default([]),
  avoidTopics: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  romance: z.enum(keys(ROMANCE_PREFS)).nullable().default(null),
  attractedTo: shortText.default(''),
  routine: shortText.default(''),
  about: z.string().trim().max(1000).default(''),
});
export type Preferences = z.infer<typeof preferencesSchema>;

export interface ProfileDto {
  /** 還沒填過偏好問卷時為 null（第一次使用） */
  preferences: Preferences | null;
  answers: AllAnswers;
  results: AssessmentResults;
  /** 系統工具模型寫的摘要（玩家可以修改） */
  summary: string;
  summaryAt: string | null;
  /** 摘要產生之後，作答或偏好又有變更 */
  summaryStale: boolean;
}

export const ATTACHMENT_LABELS: Record<AttachmentStyle, string> = {
  secure: '安全型',
  anxious: '焦慮型',
  avoidant: '逃避型',
  fearful: '恐懼逃避型',
};
