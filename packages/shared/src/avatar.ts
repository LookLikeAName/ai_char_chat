import { z } from 'zod';
import { llmBindingSchema } from './llm.ts';
import { PERSONA_PATHS, type PersonaDraft, type PersonaPath } from './persona.ts';
import { INITIAL_STAGES } from './relationship.ts';


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

export const IMAGE_STYLES = {
  anime: '日系動漫插畫風格，乾淨的線條與柔和上色',
  illustration: '溫暖的數位插畫風格',
  realistic: '寫實人像攝影，自然光，淺景深',
  watercolor: '水彩插畫風格',
  render3d: '3D 動畫電影角色風格',
} as const;
export type ImageStyle = keyof typeof IMAGE_STYLES;
export const IMAGE_STYLE_LABELS: Record<ImageStyle, string> = {
  anime: '動漫插畫',
  illustration: '數位插畫',
  realistic: '寫實照片',
  watercolor: '水彩',
  render3d: '3D 動畫',
};

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
