import { z } from 'zod';

export type ConversationType = 'dm' | 'group';
export type SenderType = 'user' | 'avatar' | 'system';

export interface MessageDto {
  id: string;
  conversationId: string;
  senderType: SenderType;
  senderAvatarId: string | null;
  content: string;
  createdAt: string;
}

export interface ConversationDto {
  id: string;
  type: ConversationType;
  /** 群組名稱；一對一時為 avatar 名稱 */
  title: string;
  imageUrl: string | null;
  memberAvatarIds: string[];
  lastMessage: MessageDto | null;
  lastMessageAt: string | null;
}

export const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(4000),
});
