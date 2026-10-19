// 伺服器經 WebSocket 推給瀏覽器的事件。api 與 worker 都透過 Redis 發佈，由 api 轉送。
import type { MessageDto } from './chat.ts';

export type ServerEvent =
  | { type: 'hello'; serverTime: string }
  | { type: 'message.created'; message: MessageDto }
  | { type: 'conversations.changed' }
  | { type: 'avatars.changed' }
  | { type: 'llmProfiles.changed' }
  | { type: 'settings.changed' };

export interface HealthDto {
  ok: boolean;
  db: boolean;
  redis: boolean;
  /** worker 最後一次心跳；超過 30 秒視為離線 */
  worker: { online: boolean; lastSeen: string | null };
  version: string;
}
