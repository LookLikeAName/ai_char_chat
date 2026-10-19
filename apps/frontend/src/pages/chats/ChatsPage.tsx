import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { PROVIDER_LABELS, resolveParams, STATUS_LABELS, type AvatarDto, type ConversationDto, type MessageDto } from '@acc/shared';
import { AvatarImage } from '../../components/AvatarImage.tsx';
import { AvatarStatePanel } from '../../components/AvatarStatePanel.tsx';
import { Icon } from '../../components/Icon.tsx';
import { api, qk } from '../../lib/api.ts';
import { clockTime, dayLabel, sameDay, shortTime } from '../../lib/format.ts';
import { useTyping } from '../../lib/serverEvents.tsx';
import { errorText, useToast } from '../../lib/toast.tsx';

export function ChatsPage() {
  const { conversationId } = useParams();
  const [infoOpen, setInfoOpen] = useState(() => window.matchMedia('(min-width: 1200px)').matches);
  const { data: conversations = [], isLoading } = useQuery({ queryKey: qk.conversations, queryFn: api.conversations });
  // 狀態（在線／忙碌／睡覺）會隨時間改變，每分鐘更新一次
  const { data: avatars = [] } = useQuery({ queryKey: qk.avatars, queryFn: api.avatars, refetchInterval: 60_000 });
  const current = conversations.find((c) => c.id === conversationId) ?? null;

  return (
    <div className={`chats${conversationId ? ' has-selection' : ''}${infoOpen && current ? ' info-open' : ''}`}>
      <ChatList conversations={conversations} avatars={avatars} loading={isLoading} selectedId={conversationId} />
      {current ? (
        <>
          <ChatView key={current.id} conversation={current} avatars={avatars} onToggleInfo={() => setInfoOpen((v) => !v)} />
          {infoOpen && <InfoPanel conversation={current} avatars={avatars} onClose={() => setInfoOpen(false)} />}
        </>
      ) : (
        <div className="chat-empty">
          <Icon name="chat" size={40} />
          <p>{conversations.length ? '選一個聊天開始吧' : '還沒有任何 avatar'}</p>
          {!conversations.length && !isLoading && (
            <Link className="btn btn-primary" to="/avatars/new">
              建立第一個 avatar
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function ChatList({
  conversations,
  avatars,
  loading,
  selectedId,
}: {
  conversations: ConversationDto[];
  avatars: AvatarDto[];
  loading: boolean;
  selectedId?: string;
}) {
  const [query, setQuery] = useState('');
  const filtered = conversations.filter((c) => c.title.toLowerCase().includes(query.trim().toLowerCase()));
  const dms = filtered.filter((c) => c.type === 'dm');
  const groups = filtered.filter((c) => c.type === 'group');

  return (
    <aside className="chat-list" aria-label="聊天列表">
      <div className="chat-list-head">
        <input
          className="search"
          type="search"
          placeholder="搜尋"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="搜尋聊天"
        />
        <Link to="/avatars/new" className="icon-btn" title="新增 avatar" aria-label="新增 avatar">
          <Icon name="plus" />
        </Link>
      </div>
      <div className="chat-list-scroll">
        {loading && <p className="hint pad">載入中…</p>}
        <Section title="個人聊天" items={dms} avatars={avatars} selectedId={selectedId} />
        <Section title="群組" items={groups} avatars={avatars} selectedId={selectedId} empty="群組功能在第 7 階段加入" />
      </div>
    </aside>
  );
}

function Section({
  title,
  items,
  avatars,
  selectedId,
  empty,
}: {
  title: string;
  items: ConversationDto[];
  avatars: AvatarDto[];
  selectedId?: string;
  empty?: string;
}) {
  return (
    <section>
      <h2 className="list-section">{title}</h2>
      {items.length === 0 && empty && <p className="hint pad">{empty}</p>}
      {items.map((c) => (
        <ChatItem
          key={c.id}
          c={c}
          avatar={c.type === 'dm' ? avatars.find((a) => a.id === c.memberAvatarIds[0]) : undefined}
          active={c.id === selectedId}
        />
      ))}
    </section>
  );
}

function StatusDot({ avatar }: { avatar?: AvatarDto }) {
  if (!avatar) return null;
  const { status, activity } = avatar.availability;
  const label = `${STATUS_LABELS[status]}${activity ? `・${activity}` : ''}`;
  return <span className={`status-badge status-${status}`} title={label} aria-label={label} role="img" />;
}

function ChatItem({ c, avatar, active }: { c: ConversationDto; avatar?: AvatarDto; active: boolean }) {
  const typing = useTyping(c.id).length > 0;
  const unread = active ? 0 : c.unreadCount;
  const preview = c.lastMessage
    ? `${c.lastMessage.senderType === 'user' ? '你：' : ''}${c.lastMessage.content}`
    : '還沒有訊息';
  return (
    <Link to={`/chats/${c.id}`} className={`chat-item${active ? ' active' : ''}`}>
      <span className="avatar-wrap">
        <AvatarImage name={c.title} src={c.imageUrl} size={44} />
        <StatusDot avatar={avatar} />
      </span>
      <span className="chat-item-body">
        <span className="chat-item-top">
          <span className="chat-item-title">{c.title}</span>
          <span className="chat-item-time">{shortTime(c.lastMessageAt)}</span>
        </span>
        <span className="chat-item-bottom">
          <span className={`chat-item-preview${typing ? ' typing-text' : ''}${unread ? ' unread-text' : ''}`}>
            {typing ? '輸入中…' : preview}
          </span>
          {unread > 0 && (
            <span className="badge" aria-label={`${unread} 則未讀`}>
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </span>
      </span>
    </Link>
  );
}

function ChatView({
  conversation,
  avatars,
  onToggleInfo,
}: {
  conversation: ConversationDto;
  avatars: AvatarDto[];
  onToggleInfo: () => void;
}) {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: qk.messages(conversation.id),
    queryFn: () => api.messages(conversation.id),
  });
  const { data: settings } = useQuery({ queryKey: qk.settings, queryFn: api.settings });
  const messages = data?.messages ?? [];
  const byId = useMemo(() => new Map(avatars.map((a) => [a.id, a])), [avatars]);
  const typingIds = useTyping(conversation.id);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dmAvatar = conversation.type === 'dm' ? byId.get(conversation.memberAvatarIds[0] ?? '') : undefined;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, typingIds.length]);

  // 正在看這個對話時，avatar 的新訊息直接算已讀
  const unread = conversation.unreadCount;
  useEffect(() => {
    const markIfVisible = () => {
      if (unread > 0 && document.visibilityState === 'visible') void api.markRead(conversation.id).catch(() => {});
    };
    markIfVisible();
    document.addEventListener('visibilitychange', markIfVisible);
    return () => document.removeEventListener('visibilitychange', markIfVisible);
  }, [conversation.id, unread]);

  // 只有最後一則非玩家訊息是錯誤時才提供重試
  const lastNonUser = [...messages].reverse().find((m) => m.senderType !== 'user');
  const retryId = lastNonUser?.systemKind === 'error' ? lastNonUser.id : null;

  return (
    <main className="chat-view">
      <header className="chat-head">
        <button className="icon-btn only-narrow" onClick={() => navigate('/chats')} aria-label="返回聊天列表">
          <Icon name="back" />
        </button>
        <AvatarImage name={conversation.title} src={conversation.imageUrl} size={36} />
        <div className="chat-head-text">
          <h1>{conversation.title}</h1>
          <span className={`chat-head-sub${typingIds.length ? ' typing-text' : ''}`}>
            {typingIds.length
              ? '輸入中…'
              : conversation.type === 'group'
                ? `${conversation.memberAvatarIds.length} 位成員`
                : dmAvatar
                  ? `${STATUS_LABELS[dmAvatar.availability.status]}${dmAvatar.availability.activity ? `・${dmAvatar.availability.activity}` : ''}`
                  : ''}
          </span>
        </div>
        <button className="icon-btn" onClick={onToggleInfo} aria-label="顯示或隱藏資訊面板" title="資訊面板">
          <Icon name="info" />
        </button>
      </header>

      <div className="messages" ref={scrollRef}>
        {isLoading && <p className="hint pad">載入中…</p>}
        {!isLoading && messages.length === 0 && (
          <div className="messages-empty">
            <p>傳一則訊息打個招呼吧。</p>
            {dmAvatar && !dmAvatar.llm && (
              <p className="hint">
                {dmAvatar.name} 還沒有綁定 LLM，<Link to={`/avatars/${dmAvatar.id}`}>先去設定大腦</Link>。
              </p>
            )}
          </div>
        )}
        <MessageList
          messages={messages}
          byId={byId}
          seenUpTo={conversation.seenUpTo}
          showThoughts={!!settings?.showInnerThoughts}
          retryId={retryId}
          onRetry={() => void api.retryReply(conversation.id)}
        />
        {typingIds.map((id) => (
          <TypingBubble key={id} avatar={byId.get(id)} />
        ))}
      </div>

      <Composer conversationId={conversation.id} />
    </main>
  );
}

function TypingBubble({ avatar }: { avatar?: AvatarDto }) {
  return (
    <div className="msg msg-theirs" aria-live="polite">
      <span className="msg-avatar">
        <AvatarImage name={avatar?.name ?? '?'} src={avatar?.imageUrl ?? null} size={32} />
      </span>
      <div className="msg-bubble typing-bubble" aria-label={`${avatar?.name ?? ''} 正在輸入`}>
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

function MessageList({
  messages,
  byId,
  seenUpTo,
  showThoughts,
  retryId,
  onRetry,
}: {
  messages: MessageDto[];
  byId: Map<string, AvatarDto>;
  seenUpTo: string | null;
  showThoughts: boolean;
  retryId: string | null;
  onRetry: () => void;
}) {
  const seenAt = seenUpTo ? Date.parse(seenUpTo) : 0;
  return (
    <>
      {messages.map((m, i) => {
        const prev = messages[i - 1];
        const newDay = !prev || !sameDay(new Date(prev.createdAt), new Date(m.createdAt));
        // 同一個人 3 分鐘內的連續訊息併成一組，只顯示一次頭像
        const grouped =
          !newDay &&
          prev?.senderType === m.senderType &&
          prev.senderAvatarId === m.senderAvatarId &&
          Date.parse(m.createdAt) - Date.parse(prev.createdAt) < 180_000;
        const mine = m.senderType === 'user';
        const sender = m.senderAvatarId ? byId.get(m.senderAvatarId) : undefined;
        return (
          <div key={m.id}>
            {newDay && <div className="day-sep">{dayLabel(m.createdAt)}</div>}
            {m.senderType === 'system' ? (
              <div className={`system-msg${m.systemKind === 'error' ? ' system-error' : ''}`}>
                {m.content}
                {m.id === retryId && (
                  <button className="btn btn-small" onClick={onRetry}>
                    重試
                  </button>
                )}
              </div>
            ) : (
              <div className={`msg ${mine ? 'msg-mine' : 'msg-theirs'}${grouped ? ' msg-grouped' : ''}`}>
                {!mine && (
                  <span className="msg-avatar">
                    {!grouped && <AvatarImage name={sender?.name ?? '?'} src={sender?.imageUrl ?? null} size={32} />}
                  </span>
                )}
                <div className="msg-content">
                  {showThoughts && (m.innerThought || m.traceId) && (
                    <div className="thought">
                      {m.innerThought && <>💭 {m.innerThought}</>}
                      {m.proactive && <span className="tag">主動</span>}
                      {m.traceId && (
                        <Link className="trace-link" to={`/monitor/traces/${m.traceId}`} title="查看這次回覆送出的 context">
                          context
                        </Link>
                      )}
                    </div>
                  )}
                  <div className="msg-line">
                    <div className="msg-bubble">{m.content}</div>
                    <span className="msg-meta">
                      {mine && seenAt >= Date.parse(m.createdAt) && <span className="msg-seen">已讀</span>}
                      <time className="msg-time" dateTime={m.createdAt}>
                        {clockTime(m.createdAt)}
                      </time>
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function Composer({ conversationId }: { conversationId: string }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const toast = useToast();
  const qc = useQueryClient();
  const send = useMutation({
    mutationFn: (content: string) => api.sendMessage(conversationId, content),
    onSuccess: (msg) => {
      qc.setQueryData<{ messages: MessageDto[]; hasMore: boolean }>(qk.messages(conversationId), (page) =>
        page && !page.messages.some((m) => m.id === msg.id) ? { ...page, messages: [...page.messages, msg] } : page,
      );
    },
    onError: (err, content) => {
      setText(content);
      toast(`送出失敗：${errorText(err)}`, 'error');
    },
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const submit = () => {
    const content = text.trim();
    if (!content) return;
    setText('');
    send.mutate(content);
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder="輸入訊息…"
        title="Enter 送出，Shift+Enter 換行"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // 注音、倉頡等輸入法選字時的 Enter 不能送出
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        aria-label="訊息"
      />
      <button type="submit" className="send-btn" disabled={!text.trim()} aria-label="送出">
        <Icon name="send" />
      </button>
    </form>
  );
}

function InfoPanel({
  conversation,
  avatars,
  onClose,
}: {
  conversation: ConversationDto;
  avatars: AvatarDto[];
  onClose: () => void;
}) {
  const avatar = conversation.type === 'dm' ? avatars.find((a) => a.id === conversation.memberAvatarIds[0]) : undefined;
  const { data: profiles = [] } = useQuery({ queryKey: qk.llmProfiles, queryFn: api.llmProfiles });
  const profile = avatar?.llm ? profiles.find((p) => p.id === avatar.llm!.profileId) : undefined;

  return (
    <aside className="info-panel" aria-label="資訊面板">
      <div className="info-head">
        <span>資訊</span>
        <button className="icon-btn" onClick={onClose} aria-label="關閉資訊面板">
          ×
        </button>
      </div>
      {avatar ? (
        <div className="info-body">
          <div className="info-hero">
            <AvatarImage name={avatar.name} src={avatar.imageUrl} size={96} />
            <h2>{avatar.name}</h2>
            {avatar.bio && <p className="info-bio">{avatar.bio}</p>}
            <Link className="btn" to={`/avatars/${avatar.id}`}>
              編輯設定
            </Link>
          </div>
          <dl className="info-list">
            <dt>大腦</dt>
            <dd>
              {profile ? (
                <>
                  {profile.name}
                  <span className="hint">
                    {PROVIDER_LABELS[profile.provider]} · {profile.model}
                  </span>
                  <code className="info-params">{JSON.stringify(resolveParams(profile.defaults, avatar.llm?.params))}</code>
                </>
              ) : (
                <span className="warn-text">尚未綁定 LLM</span>
              )}
            </dd>
          </dl>
          <AvatarStatePanel avatarId={avatar.id} />
        </div>
      ) : (
        <p className="hint pad">群組成員資訊在第 7 階段加入。</p>
      )}
    </aside>
  );
}
