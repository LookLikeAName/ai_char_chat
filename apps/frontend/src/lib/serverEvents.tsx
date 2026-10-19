// WebSocket：收到伺服器事件就更新 React Query 的快取；斷線時自動重連（指數退避，最多 15 秒）。
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { MessageDto, ServerEvent } from '@acc/shared';
import { qk } from './api.ts';

export type WsStatus = 'connecting' | 'open' | 'closed';
const WsStatusContext = createContext<WsStatus>('connecting');

export function useWsStatus(): WsStatus {
  return useContext(WsStatusContext);
}

type MessagesPage = { messages: MessageDto[]; hasMore: boolean };

export function ServerEventsProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<WsStatus>('connecting');

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const handle = (e: ServerEvent) => {
      switch (e.type) {
        case 'message.created':
          qc.setQueryData<MessagesPage>(qk.messages(e.message.conversationId), (page) =>
            page && !page.messages.some((m) => m.id === e.message.id)
              ? { ...page, messages: [...page.messages, e.message] }
              : page,
          );
          void qc.invalidateQueries({ queryKey: qk.conversations });
          break;
        case 'conversations.changed':
          void qc.invalidateQueries({ queryKey: qk.conversations });
          break;
        case 'avatars.changed':
          void qc.invalidateQueries({ queryKey: qk.avatars });
          break;
        case 'llmProfiles.changed':
          void qc.invalidateQueries({ queryKey: qk.llmProfiles });
          break;
        case 'settings.changed':
          void qc.invalidateQueries({ queryKey: qk.settings });
          break;
        case 'hello':
          break;
      }
    };

    const connect = () => {
      setStatus('connecting');
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => {
        retry = 0;
        setStatus('open');
        // 斷線期間可能漏掉事件，重連後全部重新抓
        void qc.invalidateQueries();
      };
      ws.onmessage = (msg) => {
        try {
          handle(JSON.parse(msg.data as string) as ServerEvent);
        } catch {
          // 忽略格式錯誤的事件
        }
      };
      ws.onclose = () => {
        setStatus('closed');
        if (stopped) return;
        timer = setTimeout(connect, Math.min(15_000, 500 * 2 ** retry++));
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [qc]);

  return <WsStatusContext.Provider value={status}>{children}</WsStatusContext.Provider>;
}
