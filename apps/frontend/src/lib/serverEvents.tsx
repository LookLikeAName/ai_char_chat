// WebSocket：收到伺服器事件就更新 React Query 的快取；斷線時自動重連（指數退避，最多 15 秒）。
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ConversationDto, MessageDto, ServerEvent } from '@acc/shared';
import { qk } from './api.ts';

export type WsStatus = 'connecting' | 'open' | 'closed';
const WsStatusContext = createContext<WsStatus>('connecting');

export function useWsStatus(): WsStatus {
  return useContext(WsStatusContext);
}

/** 對話 id → 正在輸入的 avatar id */
type TypingMap = Record<string, string[]>;
const TypingContext = createContext<TypingMap>({});
const NO_ONE: string[] = [];

export function useTyping(conversationId: string): string[] {
  return useContext(TypingContext)[conversationId] ?? NO_ONE;
}

/** 收不到「停止輸入」事件時（例如 worker 重啟），30 秒後自動清掉 */
const TYPING_EXPIRE_MS = 30_000;

type MessagesPage = { messages: MessageDto[]; hasMore: boolean };

export function ServerEventsProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<WsStatus>('connecting');
  const [typing, setTypingMap] = useState<TypingMap>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const setTyping = useCallback((conversationId: string, avatarId: string, on: boolean) => {
    const key = `${conversationId}:${avatarId}`;
    clearTimeout(timers.current.get(key));
    timers.current.delete(key);
    if (on) timers.current.set(key, setTimeout(() => setTyping(conversationId, avatarId, false), TYPING_EXPIRE_MS));
    setTypingMap((prev) => {
      const cur = prev[conversationId] ?? [];
      const next = on ? (cur.includes(avatarId) ? cur : [...cur, avatarId]) : cur.filter((id) => id !== avatarId);
      if (next === cur) return prev;
      return { ...prev, [conversationId]: next };
    });
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const handle = (e: ServerEvent) => {
      switch (e.type) {
        case 'message.created':
          // 訊息送出時「輸入中」一定結束了
          if (e.message.senderAvatarId) setTyping(e.message.conversationId, e.message.senderAvatarId, false);
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
        case 'messages.changed':
          void qc.invalidateQueries({ queryKey: qk.messages(e.conversationId) });
          void qc.invalidateQueries({ queryKey: qk.conversations });
          break;
        case 'typing':
          setTyping(e.conversationId, e.avatarId, e.typing);
          break;
        case 'conversation.seen':
          qc.setQueryData<ConversationDto[]>(qk.conversations, (list) =>
            list?.map((c) => (c.id === e.conversationId ? { ...c, seenUpTo: e.seenUpTo } : c)),
          );
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
        case 'avatar.state.changed':
          void qc.invalidateQueries({ queryKey: qk.avatarState(e.avatarId) });
          break;
        case 'profile.changed':
          void qc.invalidateQueries({ queryKey: qk.profile });
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
        setTypingMap({});
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
  }, [qc, setTyping]);

  return (
    <WsStatusContext.Provider value={status}>
      <TypingContext.Provider value={typing}>{children}</TypingContext.Provider>
    </WsStatusContext.Provider>
  );
}
