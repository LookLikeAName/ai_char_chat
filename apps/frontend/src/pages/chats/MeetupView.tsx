// 見面中的畫面：上面是對方（大頭照 + 現在的表情動作），下面是像劇本一樣的旁白與台詞，
// 輸入框分成「動作」和「台詞」。
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { shownName, type AvatarDto, type ConversationDto, type MeetupDto, type MessageDto } from '@acc/shared';
import { AvatarImage } from '../../components/AvatarImage.tsx';
import { Icon } from '../../components/Icon.tsx';
import { api, qk } from '../../lib/api.ts';
import { useTyping } from '../../lib/serverEvents.tsx';
import { errorText, useToast } from '../../lib/toast.tsx';

type Page = { messages: MessageDto[]; hasMore: boolean };

function useMinutesSince(iso: string): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
}

function duration(min: number): string {
  if (min < 1) return '剛碰面';
  return min < 60 ? `${min} 分鐘` : `${Math.floor(min / 60)} 小時${min % 60 ? ` ${min % 60} 分` : ''}`;
}

export function MeetupView({
  conversation,
  meetup,
  avatar,
  onToggleInfo,
}: {
  conversation: ConversationDto;
  meetup: MeetupDto;
  avatar?: AvatarDto;
  onToggleInfo: () => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: qk.messages(conversation.id), queryFn: () => api.messages(conversation.id) });
  const { data: settings } = useQuery({ queryKey: qk.settings, queryFn: api.settings });
  const typing = useTyping(conversation.id).length > 0;
  const scrollRef = useRef<HTMLDivElement>(null);
  const minutes = useMinutesSince(meetup.startedAt);
  const name = avatar ? shownName(avatar) : conversation.title;

  // 這次見面開始之後的訊息
  const since = Date.parse(meetup.startedAt);
  const lines = (data?.messages ?? []).filter((m) => Date.parse(m.createdAt) >= since);
  // 對方現在的樣子：最後一段旁白
  const lastTheirs = [...lines].reverse().find((m) => m.senderType === 'avatar' && m.narration);
  const lastNonUser = [...lines].reverse().find((m) => m.senderType !== 'user');
  const retryId = lastNonUser?.systemKind === 'error' ? lastNonUser.id : null;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, typing]);

  const unread = conversation.unreadCount;
  useEffect(() => {
    if (unread > 0 && document.visibilityState === 'visible') void api.markRead(conversation.id).catch(() => {});
  }, [conversation.id, unread]);

  const end = useMutation({
    mutationFn: () => api.endMeetup(conversation.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.conversations }),
    onError: (err) => toast(errorText(err), 'error'),
  });

  return (
    <main className="chat-view meetup-view">
      <header className="chat-head">
        <button className="icon-btn only-narrow" onClick={() => navigate('/chats')} aria-label="返回聊天列表">
          <Icon name="back" />
        </button>
        <div className="chat-head-text">
          <h1>和{name}見面中</h1>
          <span className="chat-head-sub">
            {meetup.place}
            {meetup.note ? `・${meetup.note}` : ''}・{duration(minutes)}
          </span>
        </div>
        <button
          className="btn btn-small"
          disabled={end.isPending}
          onClick={() => {
            if (confirm(`要結束這次見面嗎？之後會回到傳訊息，${name}會記得這次見面。`)) end.mutate();
          }}
        >
          結束見面
        </button>
        <button className="icon-btn" onClick={onToggleInfo} aria-label="顯示或隱藏資訊面板" title="資訊面板">
          <Icon name="info" />
        </button>
      </header>

      <section className="meet-stage" aria-label={`${name}現在的樣子`}>
        <div className="meet-portrait">
          <AvatarImage name={name} src={avatar?.imageUrl ?? conversation.imageUrl} size={132} />
        </div>
        <div className="meet-now">
          <span className="meet-name">{name}</span>
          <p className="meet-expression" aria-live="polite">
            {typing ? `${name}正要開口…` : lastTheirs?.narration ?? `你們在${meetup.place}碰面了。`}
          </p>
        </div>
      </section>

      <div className="meet-script" ref={scrollRef}>
        {lines.map((m) =>
          m.senderType === 'system' ? (
            <div key={m.id} className={`system-msg${m.systemKind === 'error' ? ' system-error' : ''}`}>
              {m.content}
              {m.id === retryId && (
                <button className="btn btn-small" onClick={() => void api.retryReply(conversation.id)}>
                  重試
                </button>
              )}
            </div>
          ) : (
            <Line key={m.id} m={m} name={m.senderType === 'user' ? '你' : name} showThoughts={!!settings?.showInnerThoughts} />
          ),
        )}
        {typing && (
          <div className="meet-line meet-theirs">
            <p className="meet-narration meet-pending">……</p>
          </div>
        )}
      </div>

      <MeetupComposer conversationId={conversation.id} name={name} />
    </main>
  );
}

function Line({ m, name, showThoughts }: { m: MessageDto; name: string; showThoughts: boolean }) {
  const mine = m.senderType === 'user';
  return (
    <div className={`meet-line ${mine ? 'meet-mine' : 'meet-theirs'}`}>
      {/* 一次回覆的幾段共用同一個想法與 context，只在第一段顯示 */}
      {showThoughts && !mine && m.innerThought && (
        <div className="thought">
          💭 {m.innerThought}
          {m.traceId && (
            <Link className="trace-link" to={`/monitor/traces/${m.traceId}`} title="查看這次回覆送出的 context">
              context
            </Link>
          )}
        </div>
      )}
      {m.narration && <p className="meet-narration">{m.narration}</p>}
      {m.content && (
        <p className="meet-say">
          <span className="meet-speaker">{name}</span>「{m.content}」
        </p>
      )}
    </div>
  );
}

function MeetupComposer({ conversationId, name }: { conversationId: string; name: string }) {
  const [action, setAction] = useState('');
  const [text, setText] = useState('');
  const sayRef = useRef<HTMLTextAreaElement>(null);
  const toast = useToast();
  const qc = useQueryClient();
  const send = useMutation({
    mutationFn: (v: { action: string; content: string }) => api.sendMessage(conversationId, v.content, undefined, v.action),
    onSuccess: (msg) => {
      qc.setQueryData<Page>(qk.messages(conversationId), (page) =>
        page && !page.messages.some((m) => m.id === msg.id) ? { ...page, messages: [...page.messages, msg] } : page,
      );
    },
    onError: (err, v) => {
      setAction(v.action);
      setText(v.content);
      toast(`送出失敗：${errorText(err)}`, 'error');
    },
  });

  useEffect(() => {
    const el = sayRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [text]);

  const submit = () => {
    const v = { action: action.trim(), content: text.trim() };
    if ((!v.action && !v.content) || send.isPending) return;
    setAction('');
    setText('');
    send.mutate(v);
    sayRef.current?.focus();
  };
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form
      className="composer meet-composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="meet-inputs">
        <input
          className="meet-action"
          value={action}
          maxLength={1000}
          placeholder={`動作（選填）：例如 遞給${name}一杯咖啡`}
          aria-label="你的動作"
          onChange={(e) => setAction(e.target.value)}
          onKeyDown={onEnter}
        />
        <textarea
          ref={sayRef}
          rows={1}
          value={text}
          maxLength={4000}
          placeholder="你想說的話…"
          title="Enter 送出，Shift+Enter 換行"
          aria-label="你的台詞"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onEnter}
        />
      </div>
      <button type="submit" className="send-btn" disabled={(!text.trim() && !action.trim()) || send.isPending} aria-label="送出">
        <Icon name="send" />
      </button>
    </form>
  );
}
