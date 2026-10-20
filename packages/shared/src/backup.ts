// 匯出／匯入設定：一般設定、LLM 設定檔（可選擇帶 API key）、玩家 profile。avatar 另外用 transfer.ts 匯出。
import { z } from 'zod';
import { llmParamsSchema, llmPricingSchema, PROFILE_KINDS, PROVIDER_TYPES } from './llm.ts';

export const SETTINGS_FORMAT = 'ai-char-chat-settings';
export const SETTINGS_VERSION = 1;

export const settingsExportOptionsSchema = z.object({
  /** 帶 API key（明碼，檔案要自己保管好） */
  apiKeys: z.stringbool().default(false),
  /** 帶玩家 profile（偏好問卷、測驗作答、摘要） */
  player: z.stringbool().default(false),
});
export type SettingsExportOptions = z.infer<typeof settingsExportOptionsSchema>;

export const exportedProfileSchema = z.object({
  /** 原本的 id；設定裡指向設定檔的地方用它對應 */
  ref: z.string().min(1).max(64),
  kind: z.enum(PROFILE_KINDS).default('chat'),
  name: z.string().trim().min(1).max(60),
  provider: z.enum(PROVIDER_TYPES),
  baseUrl: z.string().nullable().default(null),
  model: z.string().trim().min(1).max(200),
  apiKey: z.string().min(1).nullable().optional(),
  defaults: llmParamsSchema.default({}),
  pricing: llmPricingSchema.nullable().default(null),
  vision: z.boolean().nullable().default(null),
});
export type ExportedProfile = z.infer<typeof exportedProfileSchema>;

export const settingsFileSchema = z.object({
  format: z.literal(SETTINGS_FORMAT),
  version: z.number().int().min(1).max(SETTINGS_VERSION),
  exportedAt: z.string(),
  /** 一般設定；匯入時再用 appSettingsSchema 驗證（舊版缺的欄位用預設值） */
  settings: z.record(z.string(), z.unknown()),
  profiles: z.array(exportedProfileSchema).max(200).default([]),
  player: z
    .object({
      preferences: z.unknown().nullable(),
      answers: z.record(z.string(), z.unknown()).default({}),
      summary: z.string().max(10_000).default(''),
    })
    .optional(),
});
export type SettingsFile = z.infer<typeof settingsFileSchema>;

export const settingsImportSchema = z.object({
  file: settingsFileSchema,
  include: z
    .object({
      settings: z.boolean().default(true),
      profiles: z.boolean().default(true),
      player: z.boolean().default(true),
    })
    .default({ settings: true, profiles: true, player: true }),
});

export interface SettingsImportResultDto {
  /** 新建立的設定檔、和現有的一樣而沿用的設定檔 */
  profiles: { created: number; reused: number; keys: number };
  settings: boolean;
  player: boolean;
  /** 沒辦法套用的部分（例如指向的設定檔沒有匯入） */
  warnings: string[];
}
