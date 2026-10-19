// 匯出／匯入 avatar 的檔案格式。一個檔案可以有一個或多個 avatar。
// 不包含 API key 與 LLM 設定檔（匯入時另外選），也不包含群組（成員對不上）。
import { z } from 'zod';
import { llmParamsSchema } from './llm.ts';
import { moodSchema, RELATIONSHIP_EVENTS, STAGES } from './relationship.ts';

export const TRANSFER_FORMAT = 'ai-char-chat';
export const TRANSFER_VERSION = 1;
/** 一個 avatar 最多帶多少則聊天紀錄（最新的） */
export const TRANSFER_MAX_MESSAGES = 5000;

const iso = z.string().datetime({ offset: true });

export const avatarCardSchema = z.object({
  name: z.string().trim().min(1).max(40),
  bio: z.string().max(500).default(''),
  persona: z.record(z.string(), z.unknown()).default({}),
  personaLocks: z.array(z.string()).default([]),
  /** 原本綁定時覆寫的參數 */
  llmParams: llmParamsSchema.default({}),
  dailyTokenLimit: z.number().int().min(0).default(0),
  image: z
    .object({
      mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
      /** base64 */
      data: z.string().max(8_000_000),
    })
    .nullable()
    .default(null),
  /** 下面三項匯出時可以選擇不帶 */
  relationship: z
    .object({
      stage: z.enum(STAGES),
      affinity: z.number().int().min(-100).max(100),
      trust: z.number().int().min(0).max(100),
      events: z
        .array(
          z.object({
            type: z.enum(RELATIONSHIP_EVENTS),
            note: z.string().max(500).default(''),
            at: z.string(),
            from: z.enum(STAGES).optional(),
            to: z.enum(STAGES).optional(),
          }),
        )
        .max(500)
        .default([]),
    })
    .nullable()
    .optional(),
  mood: moodSchema.nullable().optional(),
  memories: z
    .array(
      z.object({
        kind: z.enum(['event', 'impression']),
        content: z.string().min(1).max(2000),
        importance: z.number().int().min(1).max(10),
        about: z.enum(['user', 'self']).default('user'),
        createdAt: iso,
      }),
    )
    .max(10_000)
    .optional(),
  /** 一對一的聊天紀錄（舊到新） */
  messages: z
    .array(
      z.object({
        sender: z.enum(['user', 'avatar']),
        content: z.string().min(1).max(4000),
        createdAt: iso,
      }),
    )
    .max(TRANSFER_MAX_MESSAGES)
    .optional(),
});
export type AvatarCard = z.infer<typeof avatarCardSchema>;

export const transferFileSchema = z.object({
  format: z.literal(TRANSFER_FORMAT),
  version: z.number().int().min(1).max(TRANSFER_VERSION),
  exportedAt: iso,
  avatars: z.array(avatarCardSchema).min(1).max(100),
});
export type TransferFile = z.infer<typeof transferFileSchema>;

export const exportOptionsSchema = z.object({
  /** 記憶、印象、關係、心情 */
  memories: z.stringbool().default(false),
  /** 一對一的聊天紀錄 */
  history: z.stringbool().default(false),
});

export const importRequestSchema = z.object({
  file: transferFileSchema,
  /** 匯入的 avatar 綁定哪個設定檔；null 表示先不綁 */
  profileId: z.uuid().nullable(),
  include: z.object({ memories: z.boolean(), history: z.boolean() }),
});
export type ImportRequest = z.infer<typeof importRequestSchema>;

export interface ImportResultDto {
  avatars: { id: string; name: string; dmConversationId: string; memories: number; messages: number }[];
}
