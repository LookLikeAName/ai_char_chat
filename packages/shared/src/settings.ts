import { z } from 'zod';
import { IMAGE_STYLES, type ImageStyle } from './images.ts';
import { llmBindingSchema } from './llm.ts';

const imageStyles = Object.keys(IMAGE_STYLES) as [ImageStyle, ...ImageStyle[]];

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '格式為 HH:MM');

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
  /** 系統工具模型：補完設定、萃取記憶、生活日誌… */
  utilityLlm: llmBindingSchema.nullable().default(null),
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
