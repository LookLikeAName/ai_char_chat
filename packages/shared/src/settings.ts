import { z } from 'zod';
import { llmBindingSchema } from './llm.ts';

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
  /** 系統工具模型：補完設定、萃取記憶、生活日誌… */
  utilityLlm: llmBindingSchema.nullable().default(null),
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
