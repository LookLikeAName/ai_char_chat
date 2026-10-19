import type { ServerEvent } from '@acc/shared';
import type { WebSocket } from 'ws';

/** 目前連線中的瀏覽器分頁；單人使用，所以事件一律廣播 */
export class WsHub {
  private readonly sockets = new Set<WebSocket>();

  add(socket: WebSocket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => this.sockets.delete(socket));
    this.send(socket, { type: 'hello', serverTime: new Date().toISOString() });
  }

  broadcast(event: ServerEvent): void {
    for (const s of this.sockets) this.send(s, event);
  }

  /** 定期 ping，避免反向代理把閒置的連線切斷 */
  ping(): void {
    for (const s of this.sockets) if (s.readyState === s.OPEN) s.ping();
  }

  get size(): number {
    return this.sockets.size;
  }

  private send(socket: WebSocket, event: ServerEvent): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
  }
}
