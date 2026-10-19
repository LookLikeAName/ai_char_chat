import type { ClientMessage, ServerEvent } from '@acc/shared';
import type { WebSocket } from 'ws';

type Topic = 'debug';

/** 目前連線中的瀏覽器分頁。一般事件一律廣播；debug 事件只送給訂閱的分頁（監控頁） */
export class WsHub {
  private readonly sockets = new Map<WebSocket, Set<Topic>>();

  add(socket: WebSocket): void {
    this.sockets.set(socket, new Set());
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => this.sockets.delete(socket));
    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as ClientMessage;
        const topics = this.sockets.get(socket);
        if (!topics || !Array.isArray(msg.topics)) return;
        for (const t of msg.topics) {
          if (t !== 'debug') continue;
          if (msg.type === 'subscribe') topics.add(t);
          else if (msg.type === 'unsubscribe') topics.delete(t);
        }
      } catch {
        // 忽略格式錯誤的訊息
      }
    });
    this.send(socket, { type: 'hello', serverTime: new Date().toISOString() });
  }

  broadcast(event: ServerEvent): void {
    const topic: Topic | null = event.type.startsWith('debug.') ? 'debug' : null;
    for (const [s, topics] of this.sockets) if (!topic || topics.has(topic)) this.send(s, event);
  }

  /** 定期 ping，避免反向代理把閒置的連線切斷 */
  ping(): void {
    for (const s of this.sockets.keys()) if (s.readyState === s.OPEN) s.ping();
  }

  get size(): number {
    return this.sockets.size;
  }

  private send(socket: WebSocket, event: ServerEvent): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
  }
}
