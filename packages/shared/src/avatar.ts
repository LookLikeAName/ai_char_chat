import { z } from 'zod';
import { avatarPhotoSchema, IMAGE_STYLES, type AvatarPhoto, type ImageStyle } from './images.ts';
import { llmBindingSchema } from './llm.ts';
import { PERSONA_PATHS, type PersonaDraft, type PersonaPath } from './persona.ts';
import { INITIAL_STAGES, STAGES } from './relationship.ts';


/**
 * 相關的角色：例如同一間公司的同事。雙方共用同一句關係描述，用名字寫清楚誰是誰
 * （「同一間設計公司的同事，林小雨是阿哲的主管」）。
 */
export const avatarLinkSchema = z.object({
  avatarId: z.uuid(),
  relation: z.string().trim().min(1, '請寫一句你們的關係').max(200),
  /** 兩個 avatar 之間一開始的關係（之後會隨互動變化）；改了會重設雙方的關係 */
  stage: z.enum(INITIAL_STAGES).default('acquaintance'),
});
export type AvatarLink = z.infer<typeof avatarLinkSchema>;
export const MAX_AVATAR_LINKS = 12;

export const avatarInputSchema = z.object({
  name: z.string().trim().min(1).max(40),
  bio: z.string().trim().max(500).default(''),
  llm: llmBindingSchema.nullable().default(null),
  /**
   * 完整人格設定。要嘛全空（只用簡介），要嘛全部填滿；伺服器會逐欄驗證。
   * 省略表示不變更。
   */
  persona: z.record(z.string(), z.unknown()).optional(),
  /** 玩家鎖定的欄位：AI 補完與一致性檢查都不會改動 */
  personaLocks: z
    .array(z.string())
    .transform((a) => [...new Set(a)].filter((p) => PERSONA_PATHS.includes(p)))
    .optional(),
  /** 每天最多用多少 tokens（0 = 不限）；省略表示不變更 */
  dailyTokenLimit: z.number().int().min(0).max(1_000_000_000).optional(),
  /** 相關的角色（整份取代）；省略表示不變更 */
  links: z.array(avatarLinkSchema).max(MAX_AVATAR_LINKS).optional(),
  /** 傳照片的方式（入鏡方式、參考圖、風格）；省略表示不變更 */
  photo: avatarPhotoSchema.optional(),
  /** 只在建立時使用：和玩家的初始關係 */
  initialStage: z.enum(INITIAL_STAGES).optional(),
});
export type AvatarInput = z.infer<typeof avatarInputSchema>;

export interface AvatarDto {
  id: string;
  name: string;
  bio: string;
  /** 例如 /media/avatars/xxx.webp；沒有上傳時為 null */
  imageUrl: string | null;
  llm: z.infer<typeof llmBindingSchema> | null;
  persona: PersonaDraft;
  personaLocks: PersonaPath[];
  /** 人格設定是否已全部填滿 */
  personaComplete: boolean;
  /** 每天最多用多少 tokens（0 = 不限） */
  dailyTokenLimit: number;
  photo: AvatarPhoto;
  /** 相關的角色（不管是哪一邊設定的都會列出來） */
  links: AvatarLink[];
  /** 另外上傳的照片參考圖 */
  photoReferenceUrl: string | null;
  /** 依作息推算的目前狀態 */
  availability: { status: 'free' | 'busy' | 'sleep'; activity: string; until: string | null };
  /** 這個 avatar 的一對一聊天 */
  dmConversationId: string;
  createdAt: string;
  updatedAt: string;
}

/** AI 補完：沒給 avatar id 也能用（新增中的 avatar） */
export const personaGenerateSchema = z.object({
  name: z.string().trim().max(40).default(''),
  bio: z.string().trim().max(500).default(''),
  persona: z.record(z.string(), z.unknown()).default({}),
  locks: z.array(z.string()).default([]),
  /** 「從一句話開始」的描述 */
  seed: z.string().trim().max(500).optional(),
  /** 要（重新）產生的欄位；省略表示所有還沒填的欄位 */
  only: z.array(z.string()).optional(),
  /** 參考的角色：新設定要和他們一致 */
  references: z.array(avatarLinkSchema).max(MAX_AVATAR_LINKS).default([]),
  /** 和玩家目前（或一開始）的關係：「和玩家的關係」區塊要符合 */
  userStage: z.enum(STAGES).optional(),
});
export type PersonaGenerateInput = z.input<typeof personaGenerateSchema>;

export interface PersonaGenerateResult {
  name: string;
  bio: string;
  persona: PersonaDraft;
  /** 這次填入的欄位 */
  filled: PersonaPath[];
  /** 模型給了不合法的值、沒能填上的欄位 */
  failed: PersonaPath[];
}

export const personaCheckSchema = z.object({
  name: z.string().trim().max(40).default(''),
  bio: z.string().trim().max(500).default(''),
  persona: z.record(z.string(), z.unknown()),
  locks: z.array(z.string()).default([]),
  references: z.array(avatarLinkSchema).max(MAX_AVATAR_LINKS).default([]),
  userStage: z.enum(STAGES).optional(),
});

export interface PersonaIssue {
  /** 互相矛盾的欄位 */
  fields: PersonaPath[];
  problem: string;
  /** 建議的修改；只會包含沒鎖定的欄位 */
  suggestion: Record<PersonaPath, unknown>;
}

export const avatarImageGenerateSchema = z.object({
  prompt: z.string().trim().min(1).max(2000),
});

/** 依外貌與穿著組出預設的頭像提示詞，玩家可以再修改 */
export function defaultImagePrompt(name: string, persona: PersonaDraft, style: ImageStyle): string {
  const b = persona.basic ?? {};
  const parts = [
    `通訊軟體的大頭貼：一位${b.age ? `${b.age} 歲的` : ''}${b.gender ?? ''}角色「${name}」的頭部與肩膀特寫，正方形構圖，看向鏡頭。`,
    b.appearance ? `外貌：${b.appearance}` : '',
    b.style ? `穿著：${b.style}` : '',
    persona.personality?.traits?.length ? `表情與氣質要表現出：${persona.personality.traits.slice(0, 3).join('、')}。` : '',
    `畫風：${IMAGE_STYLES[style]}。`,
    '單一人物、背景簡單、沒有文字或浮水印，非裸露、適合所有年齡觀看。',
  ];
  return parts.filter(Boolean).join('\n');
}
