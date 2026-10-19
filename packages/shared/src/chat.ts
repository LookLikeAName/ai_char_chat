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
  /** avatar 這一輪回覆的內心想法（設定開啟「顯示內心想法」時才會帶） */
  innerThought: string | null;
  /** 系統訊息的種類：error 會在介面上提供「重試」 */
  systemKind: 'error' | 'notice' | null;
  /** 產生這則訊息的 LLM 呼叫（監控頁可以查看完整 context） */
  traceId: string | null;
  /** avatar 主動傳的 */
  proactive: boolean;
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
  /** 玩家還沒看過的 avatar 訊息數 */
  unreadCount: number;
  /** 一對一時：avatar 已讀到哪個時間點（含） */
  seenUpTo: string | null;
  /** 每個成員已讀到哪裡（群組顯示「已讀 N」） */
  members: { avatarId: string; seenUpTo: string | null }[];
}

export const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(4000),
});

export const groupInputSchema = z.object({
  title: z.string().trim().min(1).max(40),
  avatarIds: z.array(z.uuid()).min(2, '群組至少要有 2 個 avatar').max(8),
});
export type GroupInput = z.infer<typeof groupInputSchema>;
