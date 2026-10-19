// 伺服器經 WebSocket 推給瀏覽器的事件。api 與 worker 都透過 Redis 發佈，由 api 轉送。
import type { MessageDto } from './chat.ts';
import type { DebugEventDto, TraceSummaryDto } from './debug.ts';

export type ServerEvent =
  | { type: 'hello'; serverTime: string }
  | { type: 'message.created'; message: MessageDto }
  | { type: 'conversations.changed' }
  /** 訊息被刪除或修改，需要重新載入 */
  | { type: 'messages.changed'; conversationId: string }
  /** avatar 正在輸入；typing = false 表示停止（送出或放棄） */
  | { type: 'typing'; conversationId: string; avatarId: string; typing: boolean }
  /** avatar 讀了玩家的訊息 */
  | { type: 'conversation.seen'; conversationId: string; avatarId: string; seenUpTo: string }
  | { type: 'avatars.changed' }
  | { type: 'llmProfiles.changed' }
  | { type: 'settings.changed' }
  | { type: 'profile.changed' }
  /** 心情、關係或記憶有變化 */
  | { type: 'avatar.state.changed'; avatarId: string }
  /** 只送給訂閱了 debug 的分頁（監控頁） */
  | { type: 'debug.event'; event: DebugEventDto }
  | { type: 'debug.trace'; trace: TraceSummaryDto };

/** 瀏覽器送給伺服器的訊息 */
export type ClientMessage = { type: 'subscribe'; topics: 'debug'[] } | { type: 'unsubscribe'; topics: 'debug'[] };

export interface HealthDto {
  ok: boolean;
  db: boolean;
  redis: boolean;
  /** worker 最後一次心跳；超過 30 秒視為離線 */
  worker: { online: boolean; lastSeen: string | null };
  version: string;
}
