// 第 1 階段只有基本欄位；完整人格設定在第 3 階段（avatar creator）加入 persona。
import { z } from 'zod';
import { llmBindingSchema } from './llm.ts';

export const avatarInputSchema = z.object({
  name: z.string().trim().min(1).max(40),
  bio: z.string().trim().max(500).default(''),
  llm: llmBindingSchema.nullable().default(null),
});
export type AvatarInput = z.infer<typeof avatarInputSchema>;

export interface AvatarDto {
  id: string;
  name: string;
  bio: string;
  /** 例如 /media/avatars/xxx.webp；沒有上傳時為 null */
  imageUrl: string | null;
  llm: z.infer<typeof llmBindingSchema> | null;
  /** 這個 avatar 的一對一聊天 */
  dmConversationId: string;
  createdAt: string;
  updatedAt: string;
}
