import { z } from 'zod';
import { IMAGE_STYLES, type ImageStyle } from './images.ts';
import { llmBindingSchema, type LlmBinding } from './llm.ts';

const imageStyles = Object.keys(IMAGE_STYLES) as [ImageStyle, ...ImageStyle[]];

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '格式為 HH:MM');

/** 系統工具模型負責的功能，可以各自指定模型（例如補完角色用好一點的、摘要用便宜的） */
export const UTILITY_TASKS = ['persona', 'summary', 'memory', 'life', 'caption', 'judge'] as const;
export type UtilityTask = (typeof UTILITY_TASKS)[number];

export const UTILITY_TASK_LABELS: Record<UtilityTask, { title: string; hint: string }> = {
  persona: { title: '補完角色與一致性檢查', hint: '產生整份人格設定，建議用比較好的模型' },
  summary: { title: '玩家摘要', hint: '測驗做完後整理你的 profile 摘要' },
  memory: { title: '整理記憶與印象', hint: '聊天告一段落時萃取記憶、每天整理對你的印象；呼叫次數最多' },
  life: { title: '生活日誌', hint: '每個 avatar 每天產生一次今天發生的事' },
  caption: { title: '描述圖片', hint: '聊天模型看不懂圖片時，用它替圖片寫文字描述；要選看得懂圖片的模型' },
  judge: { title: '成人內容測試的判斷', hint: '替測試結果分級' },
};

/** 用途（usage_log 的 purpose）屬於哪個功能 */
export const UTILITY_TASK_OF: Record<string, UtilityTask> = {
  'persona.generate': 'persona',
  'persona.check': 'persona',
  'profile.summary': 'summary',
  'memory.extract': 'memory',
  'memory.reflect': 'memory',
  'life.log': 'life',
  'image.caption': 'caption',
  'adult.test': 'judge',
};

/** 這個功能用哪個系統工具模型：有另外指定就用它，否則用預設的 */
export function utilityBinding(settings: Pick<AppSettings, 'utilityLlm' | 'utilityByTask'>, task: UtilityTask): LlmBinding | null {
  return settings.utilityByTask?.[task] ?? settings.utilityLlm ?? null;
}

/** 所有系統工具模型用到的設定檔 */
export function utilityProfileIds(settings: Pick<AppSettings, 'utilityLlm' | 'utilityByTask'>): string[] {
  return [settings.utilityLlm, ...Object.values(settings.utilityByTask ?? {})].flatMap((b) => (b ? [b.profileId] : []));
}

export const appSettingsSchema = z.object({
  /** 作息、勿擾時段都用這個時區計算 */
  timezone: z.string().min(1).default('Asia/Taipei'),
  /** avatar 不主動發話的時段（玩家自己的作息） */
  quietHours: z
    .object({ enabled: z.boolean(), start: hhmm, end: hhmm })
    .default({ enabled: true, start: '00:30', end: '08:00' }),
  /** 成人內容；開啟前前端要求確認已滿 18 歲 */
  adultContent: z.boolean().default(false),
  /** avatar 回覆的節奏：擬真（依作息）、輕鬆（縮短）、即時 */
  replyPacing: z.enum(['realistic', 'relaxed', 'instant']).default('realistic'),
  /** avatar 主動傳訊息 */
  proactive: z
    .object({ enabled: z.boolean(), dailyLimit: z.number().int().min(0).max(20) })
    .default({ enabled: true, dailyLimit: 3 }),
  /** 在聊天畫面顯示 avatar 的內心想法（偷看用，也方便調整角色） */
  showInnerThoughts: z.boolean().default(false),
  /** 系統工具模型：補完設定、萃取記憶、生活日誌…（預設，每個功能可以另外指定） */
  utilityLlm: llmBindingSchema.nullable().default(null),
  /** 依功能指定的系統工具模型；沒指定的用 utilityLlm */
  utilityByTask: z.partialRecord(z.enum(UTILITY_TASKS), llmBindingSchema).default({}),
  /** 頭像與照片生成：用哪個「圖片生成」設定檔（模型就是設定檔裡的模型） */
  imageGen: z.object({ profileId: z.uuid() }).nullable().default(null),
  /** avatar 傳照片（用頭像生成的圖片模型）：每個 avatar 每天最多幾張、照片的風格 */
  photos: z
    .object({ enabled: z.boolean(), dailyLimit: z.number().int().min(0).max(50), style: z.enum(imageStyles) })
    .default({ enabled: true, dailyLimit: 5, style: 'realistic' }),
  /** 記憶用的嵌入模型：用哪個「記憶嵌入」設定檔；向量固定 768 維 */
  embedding: z.object({ profileId: z.uuid() }).nullable().default(null),
  /** 除錯：記錄每次 LLM 呼叫的完整 context；事件與紀錄保留天數 */
  debug: z
    .object({ captureContext: z.boolean(), retentionDays: z.number().int().min(1).max(90) })
    .default({ captureContext: true, retentionDays: 7 }),
  /** 全域每日 token 上限；0 表示不限 */
  dailyTokenLimit: z.number().int().min(0).default(0),
});
export type AppSettings = z.infer<typeof appSettingsSchema>;

/**
 * 部分更新用。不能直接用 `.partial()`：zod 4 會對缺少的欄位套用預設值，
 * 導致只改時區時其他欄位被重設。所以先拆掉每個欄位的預設值再設為 optional。
 */
export const appSettingsPatchSchema = z.object(
  Object.fromEntries(
    Object.entries(appSettingsSchema.shape).map(([key, field]) => [key, field.unwrap().optional()]),
  ),
) as unknown as z.ZodType<Partial<AppSettings>>;

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 測試一個聊天模型能不能寫成人內容（設定 → 一般 → 內容） */
export const adultTestSchema = z.object({ profileId: z.uuid() });

export const ADULT_TEST_VERDICTS = ['allowed', 'partial', 'refused', 'blocked', 'error'] as const;
export type AdultTestVerdict = (typeof ADULT_TEST_VERDICTS)[number];

export const ADULT_TEST_LABELS: Record<AdultTestVerdict, { title: string; text: string }> = {
  allowed: { title: '可以', text: '模型照著角色寫出了露骨的親密內容。' },
  partial: { title: '只到暗示', text: '模型願意調情、曖昧，但避開露骨的描寫（通常是模型本身的限制）。' },
  refused: { title: '拒絕', text: '模型拒絕了，或跳出角色說明它不能寫這類內容。' },
  blocked: { title: '被供應商擋下', text: '供應商的安全過濾直接擋掉了這次回覆。' },
  error: { title: '測試失敗', text: '呼叫模型時發生錯誤，沒辦法判斷。' },
};

export interface AdultTestResult {
  verdict: AdultTestVerdict;
  /** 判斷的理由，或錯誤訊息 */
  reason: string;
  /** 模型的回覆（訊息內容）；被擋下或失敗時是空的 */
  reply: string[];
  finishReason: string | null;
  /** 誰判斷的：系統工具模型，或沒有設定時用關鍵字 */
  judgedBy: 'utility' | 'keywords' | 'provider';
  model: string;
}
