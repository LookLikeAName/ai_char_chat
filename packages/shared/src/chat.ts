import { z } from 'zod';
import type { MeetupDto } from './meetup.ts';

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
  /** 圖片訊息（玩家傳的圖、avatar 傳的照片） */
  image: MessageImageDto | null;
  /** 見面時的旁白：avatar 的表情、動作、語氣，或玩家自己寫的動作 */
  narration: string | null;
  /** 見面時說的（不是傳訊息） */
  meetupId: string | null;
}

export interface MessageImageDto {
  url: string;
  width: number | null;
  height: number | null;
  /** avatar 傳的照片：照片的內容（生成用的描述） */
  description: string | null;
}

/** 上傳後拿到的 id，送出訊息時帶上 */
export interface UploadDto {
  id: string;
  url: string;
  width: number | null;
  height: number | null;
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
  /** 一對一：正在進行的見面 */
  meetup: MeetupDto | null;
}

export const UPLOAD_ID_PATTERN = /^[0-9a-f-]{36}\.(png|jpg|webp|gif)$/;

export const sendMessageSchema = z
  .object({
    content: z.string().trim().max(4000).default(''),
    /** 先上傳（POST /uploads）拿到的 id */
    image: z.string().regex(UPLOAD_ID_PATTERN).optional(),
    /** 見面時：你的動作（旁白） */
    action: z.string().trim().max(1000).default(''),
  })
  .refine((m) => m.content || m.image || m.action, { message: '訊息是空的' });

/** 聊天列表與通知用的一行文字 */
export function messagePreview(m: Pick<MessageDto, 'content' | 'image' | 'senderType'> & { narration?: string | null }): string {
  if (!m.image) return m.content || (m.narration ? `（${m.narration}）` : '');
  const tag = m.senderType === 'avatar' ? '［照片］' : '［圖片］';
  return m.content ? `${tag} ${m.content}` : tag;
}

export const groupInputSchema = z.object({
  title: z.string().trim().min(1).max(40),
  avatarIds: z.array(z.uuid()).min(2, '群組至少要有 2 個 avatar').max(8),
});
export type GroupInput = z.infer<typeof groupInputSchema>;
