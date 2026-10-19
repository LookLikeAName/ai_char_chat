import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import {
  messagePreview,
  PROVIDER_LABELS,
  resolveParams,
  shownName,
  STATUS_LABELS,
  type AvatarDto,
  type ConversationDto,
  type MessageDto,
  type MessageImageDto,
} from '@acc/shared';
import { AvatarImage } from '../../components/AvatarImage.tsx';
import { AvatarStatePanel } from '../../components/AvatarStatePanel.tsx';
import { GroupDialog } from '../../components/GroupDialog.tsx';
import { Icon } from '../../components/Icon.tsx';
import { api, qk } from '../../lib/api.ts';
import { clockTime, dayLabel, sameDay, shortTime } from '../../lib/format.ts';
import { useTyping } from '../../lib/serverEvents.tsx';
import { prepareImage } from '../../lib/images.ts';
import { errorText, useToast } from '../../lib/toast.tsx';

export function ChatsPage() {
  const { conversationId } = useParams();
  const [infoOpen, setInfoOpen] = useState(() => window.matchMedia('(min-width: 1200px)').matches);
  const { data: conversations = [], isLoading } = useQuery({ queryKey: qk.conversations, queryFn: api.conversations });
  // 狀態（在線／忙碌／睡覺）會隨時間改變，每分鐘更新一次
  const { data: avatars = [] } = useQuery({ queryKey: qk.avatars, queryFn: api.avatars, refetchInterval: 60_000 });
  const current = conversations.find((c) => c.id === conversationId) ?? null;
  // 資訊面板按「@」時插入到輸入框；n 讓同一個名字可以連按
  const [mention, setMention] = useState<{ name: string; n: number } | null>(null);

  return (
    <div className={`chats${conversationId ? ' has-selection' : ''}${infoOpen && current ? ' info-open' : ''}`}>
      <ChatList conversations={conversations} avatars={avatars} loading={isLoading} selectedId={conversationId} />
      {current ? (
        <>
          <ChatView
            key={current.id}
            conversation={current}
            avatars={avatars}
            mention={mention}
            onToggleInfo={() => setInfoOpen((v) => !v)}
          />
          {infoOpen && (
            <InfoPanel
              conversation={current}
              avatars={avatars}
              onMention={(name) => setMention((m) => ({ name, n: (m?.n ?? 0) + 1 }))}
              onClose={() => setInfoOpen(false)}
            />
          )}
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
  const [creating, setCreating] = useState(false);
  // 標題、成員的顯示名稱或本名都可以搜
  const q = query.trim().toLowerCase();
  const filtered = conversations.filter(
    (c) =>
      c.title.toLowerCase().includes(q) ||
      c.members.some((m) => {
        const a = avatars.find((x) => x.id === m.avatarId);
        return !!a && `${a.name} ${a.displayName}`.toLowerCase().includes(q);
      }),
  );
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
        <Section
          title="群組"
          items={groups}
          avatars={avatars}
          selectedId={selectedId}
          empty={avatars.length >= 2 ? '按 + 建立群組' : '至少要有 2 個 avatar 才能建立群組'}
          action={
            <button className="icon-btn icon-btn-small" onClick={() => setCreating(true)} title="建立群組" aria-label="建立群組">
              <Icon name="plus" size={16} />
            </button>
          }
        />
      </div>
      {creating && <GroupDialog onClose={() => setCreating(false)} />}
    </aside>
  );
}

function Section({
  title,
  items,
  avatars,
  selectedId,
  empty,
  action,
}: {
  title: string;
  items: ConversationDto[];
  avatars: AvatarDto[];
  selectedId?: string;
  empty?: string;
  action?: ReactNode;
}) {
  return (
    <section>
      <h2 className="list-section">
        {title}
        {action}
      </h2>
      {items.length === 0 && empty && <p className="hint pad">{empty}</p>}
      {items.map((c) => (
        <ChatItem
          key={c.id}
          c={c}
          avatar={c.type === 'dm' ? avatars.find((a) => a.id === c.memberAvatarIds[0]) : undefined}
          avatars={avatars}
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

function typingNames(ids: string[], avatars: AvatarDto[]): string {
  const names = ids.map((id) => {
    const a = avatars.find((x) => x.id === id);
    return a ? shownName(a) : '?';
  });
  return names.length > 2 ? `${names.slice(0, 2).join('、')} 等 ${names.length} 人` : names.join('、');
}

/** 群組頭像：前兩位成員疊在一起 */
function GroupImage({
  memberIds,
  avatars,
  title,
  size,
}: {
  memberIds: string[];
  avatars: AvatarDto[];
  title: string;
  size: number;
}) {
  const members = memberIds.map((id) => avatars.find((a) => a.id === id)).filter((a): a is AvatarDto => !!a);
  if (members.length < 2) return <AvatarImage name={title} src={null} size={size} />;
  const small = Math.round(size * 0.68);
  return (
    <span className="group-image" style={{ width: size, height: size }} aria-hidden>
      <AvatarImage name={shownName(members[0]!)} src={members[0]!.imageUrl} size={small} />
      <AvatarImage name={shownName(members[1]!)} src={members[1]!.imageUrl} size={small} />
    </span>
  );
}

function ChatItem({
  c,
  avatar,
  avatars,
  active,
}: {
  c: ConversationDto;
  avatar?: AvatarDto;
  avatars: AvatarDto[];
  active: boolean;
}) {
  const typingIds = useTyping(c.id);
  const typing = typingIds.length > 0;
  const unread = active ? 0 : c.unreadCount;
  const last = c.lastMessage;
  const senderName =
    last?.senderType === 'user'
      ? '你'
      : c.type === 'group' && last?.senderAvatarId
        ? (() => {
            const a = avatars.find((x) => x.id === last.senderAvatarId);
            return a && shownName(a);
          })()
        : undefined;
  const preview = last ? `${senderName ? `${senderName}：` : ''}${messagePreview(last)}` : '還沒有訊息';
  const typingText = c.type === 'group' ? `${typingNames(typingIds, avatars)} 輸入中…` : '輸入中…';
  return (
    <Link to={`/chats/${c.id}`} className={`chat-item${active ? ' active' : ''}`}>
      <span className="avatar-wrap">
        {c.type === 'group' ? (
          <GroupImage memberIds={c.memberAvatarIds} avatars={avatars} title={c.title} size={44} />
        ) : (
          <AvatarImage name={c.title} src={c.imageUrl} size={44} />
        )}
        <StatusDot avatar={avatar} />
      </span>
      <span className="chat-item-body">
        <span className="chat-item-top">
          <span className="chat-item-title">{c.title}</span>
          <span className="chat-item-time">{shortTime(c.lastMessageAt)}</span>
        </span>
        <span className="chat-item-bottom">
          <span className={`chat-item-preview${typing ? ' typing-text' : ''}${unread ? ' unread-text' : ''}`}>
            {typing ? typingText : preview}
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
  mention,
  onToggleInfo,
}: {
  conversation: ConversationDto;
  avatars: AvatarDto[];
  mention: { name: string; n: number } | null;
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
  const isGroup = conversation.type === 'group';
  // 把圖片拖進聊天畫面就附加到輸入框
  const [dropped, setDropped] = useState<{ file: File; n: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [viewer, setViewer] = useState<MessageImageDto | null>(null);
  const dmAvatar = !isGroup ? byId.get(conversation.memberAvatarIds[0] ?? '') : undefined;

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
    <main
      className={`chat-view${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => {
        if (![...e.dataTransfer.items].some((i) => i.kind === 'file')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
        if (file) setDropped((d) => ({ file, n: (d?.n ?? 0) + 1 }));
      }}
    >
      <header className="chat-head">
        <button className="icon-btn only-narrow" onClick={() => navigate('/chats')} aria-label="返回聊天列表">
          <Icon name="back" />
        </button>
        {isGroup ? (
          <GroupImage memberIds={conversation.memberAvatarIds} avatars={avatars} title={conversation.title} size={36} />
        ) : (
          <AvatarImage name={conversation.title} src={conversation.imageUrl} size={36} />
        )}
        <div className="chat-head-text">
          <h1>{conversation.title}</h1>
          <span className={`chat-head-sub${typingIds.length ? ' typing-text' : ''}`}>
            {typingIds.length
              ? isGroup
                ? `${typingNames(typingIds, avatars)} 輸入中…`
                : '輸入中…'
              : isGroup
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
                {shownName(dmAvatar)} 還沒有綁定 LLM，<Link to={`/avatars/${dmAvatar.id}`}>先去設定大腦</Link>。
              </p>
            )}
          </div>
        )}
        <MessageList
          messages={messages}
          byId={byId}
          isGroup={isGroup}
          seenUpTo={conversation.seenUpTo}
          members={conversation.members}
          showThoughts={!!settings?.showInnerThoughts}
          retryId={retryId}
          onRetry={() => void api.retryReply(conversation.id)}
          onOpenImage={setViewer}
        />
        {typingIds.map((id) => (
          <TypingBubble key={id} avatar={byId.get(id)} />
        ))}
      </div>

      <Composer conversationId={conversation.id} isGroup={isGroup} mention={mention} dropped={dropped} />
      {viewer && <ImageViewer image={viewer} onClose={() => setViewer(null)} />}
    </main>
  );
}

function TypingBubble({ avatar }: { avatar?: AvatarDto }) {
  return (
    <div className="msg msg-theirs" aria-live="polite">
      <span className="msg-avatar">
        <AvatarImage name={avatar ? shownName(avatar) : '?'} src={avatar?.imageUrl ?? null} size={32} />
      </span>
      <div className="msg-bubble typing-bubble" aria-label={`${avatar ? shownName(avatar) : ''} 正在輸入`}>
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
  isGroup,
  seenUpTo,
  members,
  showThoughts,
  retryId,
  onRetry,
  onOpenImage,
}: {
  messages: MessageDto[];
  byId: Map<string, AvatarDto>;
  isGroup: boolean;
  seenUpTo: string | null;
  members: ConversationDto['members'];
  showThoughts: boolean;
  retryId: string | null;
  onRetry: () => void;
  onOpenImage: (image: MessageImageDto) => void;
}) {
  const seenAt = seenUpTo ? Date.parse(seenUpTo) : 0;
  const memberSeen = members.map((m) => (m.seenUpTo ? Date.parse(m.seenUpTo) : 0));
  const seenLabel = (createdAt: string): string | null => {
    const t = Date.parse(createdAt);
    if (!isGroup) return seenAt >= t ? '已讀' : null;
    const n = memberSeen.filter((s) => s >= t).length;
    return n ? `已讀 ${n}` : null;
  };
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
        const seen = mine ? seenLabel(m.createdAt) : null;
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
                    {!grouped && <AvatarImage name={sender ? shownName(sender) : '?'} src={sender?.imageUrl ?? null} size={32} />}
                  </span>
                )}
                <div className="msg-content">
                  {isGroup && !mine && !grouped && <div className="msg-sender">{sender ? shownName(sender) : '（已刪除）'}</div>}
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
                    <div className={`msg-stack${m.image ? ' has-image' : ''}`}>
                      {m.image && <MessageImage image={m.image} onOpen={() => onOpenImage(m.image!)} />}
                      {m.content && <div className="msg-bubble">{m.content}</div>}
                    </div>
                    <span className="msg-meta">
                      {seen && <span className="msg-seen">{seen}</span>}
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

/** 群組：玩家打字時通知伺服器，這一輪會等玩家打完（伺服器等 3 秒） */
const TYPING_PING_MS = 2000;

function Composer({
  conversationId,
  isGroup,
  mention,
  dropped,
}: {
  conversationId: string;
  isGroup: boolean;
  mention: { name: string; n: number } | null;
  dropped: { file: File; n: number } | null;
}) {
  const [text, setText] = useState('');
  const [attachment, setAttachment] = useState<{ file: File; preview: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastPing = useRef(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const toast = useToast();
  const qc = useQueryClient();
  const attach = (file: File) => {
    if (!file.type.startsWith('image/')) return toast('只能傳圖片', 'error');
    setAttachment({ file, preview: URL.createObjectURL(file) });
    ref.current?.focus();
  };
  const droppedN = dropped?.n;
  useEffect(() => {
    if (dropped) attach(dropped.file);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [droppedN]);
  useEffect(
    () => () => {
      if (attachment) URL.revokeObjectURL(attachment.preview);
    },
    [attachment],
  );

  const send = useMutation({
    mutationFn: async ({ content, file }: { content: string; file: File | null }) => {
      const image = file ? (await api.upload(await prepareImage(file))).id : undefined;
      return api.sendMessage(conversationId, content, image);
    },
    onSuccess: (msg) => {
      qc.setQueryData<{ messages: MessageDto[]; hasMore: boolean }>(qk.messages(conversationId), (page) =>
        page && !page.messages.some((m) => m.id === msg.id) ? { ...page, messages: [...page.messages, msg] } : page,
      );
    },
    onError: (err, { content, file }) => {
      setText(content);
      if (file) attach(file);
      toast(`送出失敗：${errorText(err)}`, 'error');
    },
  });

  // 資訊面板按了「@」
  const mentionN = mention?.n;
  const handledMention = useRef(mentionN);
  useEffect(() => {
    if (!mention || handledMention.current === mentionN) return;
    handledMention.current = mentionN;
    setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}@${mention.name} `);
    ref.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mentionN]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const submit = () => {
    const content = text.trim();
    const file = attachment?.file ?? null;
    if ((!content && !file) || send.isPending) return;
    setText('');
    setAttachment(null);
    send.mutate({ content, file });
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {attachment && (
        <div className="composer-attachment">
          <img src={attachment.preview} alt="要傳的圖片" />
          <button type="button" className="icon-btn icon-btn-small" onClick={() => setAttachment(null)} aria-label="不傳這張圖片">
            ×
          </button>
        </div>
      )}
      <button
        type="button"
        className="icon-btn"
        onClick={() => fileRef.current?.click()}
        aria-label="傳圖片"
        title="傳圖片（也可以貼上或拖進來）"
      >
        <Icon name="image" />
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) attach(f);
          e.target.value = '';
        }}
      />
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder={isGroup ? '輸入訊息…（@名字 可以點名）' : '輸入訊息…'}
        title="Enter 送出，Shift+Enter 換行"
        onChange={(e) => {
          setText(e.target.value);
          const now = Date.now();
          if (isGroup && e.target.value.trim() && now - lastPing.current > TYPING_PING_MS) {
            lastPing.current = now;
            void api.typing(conversationId).catch(() => {});
          }
        }}
        onPaste={(e) => {
          const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'));
          if (file) {
            e.preventDefault();
            attach(file);
          }
        }}
        onKeyDown={(e) => {
          // 注音、倉頡等輸入法選字時的 Enter 不能送出
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        aria-label="訊息"
      />
      <button type="submit" className="send-btn" disabled={(!text.trim() && !attachment) || send.isPending} aria-label="送出">
        <Icon name="send" />
      </button>
    </form>
  );
}

function InfoPanel({
  conversation,
  avatars,
  onMention,
  onClose,
}: {
  conversation: ConversationDto;
  avatars: AvatarDto[];
  onMention: (name: string) => void;
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
            <AvatarImage name={shownName(avatar)} src={avatar.imageUrl} size={96} />
            <h2>{shownName(avatar)}</h2>
            {shownName(avatar) !== avatar.name && <p className="hint">本名 {avatar.name}</p>}
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
      ) : conversation.type === 'group' ? (
        <GroupInfo conversation={conversation} avatars={avatars} onMention={onMention} />
      ) : (
        <p className="hint pad">找不到這個 avatar。</p>
      )}
    </aside>
  );
}

function GroupInfo({
  conversation,
  avatars,
  onMention,
}: {
  conversation: ConversationDto;
  avatars: AvatarDto[];
  onMention: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const { data: conversations = [] } = useQuery({ queryKey: qk.conversations, queryFn: api.conversations });
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.deleteGroup(conversation.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.conversations });
      navigate('/chats');
    },
    onError: (err) => toast(errorText(err), 'error'),
  });
  const members = conversation.memberAvatarIds
    .map((id) => avatars.find((a) => a.id === id))
    .filter((a): a is AvatarDto => !!a);
  const dmOf = (avatarId: string) =>
    conversations.find((c) => c.type === 'dm' && c.memberAvatarIds[0] === avatarId)?.id;

  return (
    <div className="info-body">
      <div className="info-hero">
        <GroupImage memberIds={conversation.memberAvatarIds} avatars={avatars} title={conversation.title} size={96} />
        <h2>{conversation.title}</h2>
        <p className="info-bio">{members.length} 位成員</p>
        <button className="btn" onClick={() => setEditing(true)}>
          編輯群組
        </button>
      </div>
      <h3 className="info-section">成員</h3>
      <ul className="member-list">
        {members.map((a) => {
          const { status, activity } = a.availability;
          const dm = dmOf(a.id);
          return (
            <li key={a.id}>
              <span className="avatar-wrap">
                <AvatarImage name={shownName(a)} src={a.imageUrl} size={36} />
                <StatusDot avatar={a} />
              </span>
              <span className="member-text">
                <span className="member-name">{shownName(a)}</span>
                <span className="hint">
                  {a.llm ? `${STATUS_LABELS[status]}${activity ? `・${activity}` : ''}` : '沒有綁定 LLM'}
                </span>
              </span>
              <button className="icon-btn icon-btn-small" onClick={() => onMention(shownName(a))} title={`@${shownName(a)}`} aria-label={`點名 ${shownName(a)}`}>
                @
              </button>
              {dm && (
                <Link className="icon-btn icon-btn-small" to={`/chats/${dm}`} title="私訊" aria-label={`和 ${shownName(a)} 私訊`}>
                  <Icon name="chat" size={16} />
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      <p className="hint">
        私訊裡聊的事，avatar 在群組裡會依自己的個性決定要不要提（「人格設定 → 行為準則 → 口風」）。
      </p>
      <button
        className="btn btn-danger"
        onClick={() => {
          if (confirm(`確定要刪除「${conversation.title}」嗎？群組的聊天紀錄會一起刪除，avatar 記得的事不會刪除。`)) remove.mutate();
        }}
      >
        刪除群組
      </button>
      {editing && <GroupDialog group={conversation} onClose={() => setEditing(false)} />}
    </div>
  );
}

/** 訊息裡的圖片：先依尺寸留好位置，載入時畫面才不會跳 */
function MessageImage({ image, onOpen }: { image: MessageImageDto; onOpen: () => void }) {
  const ratio = image.width && image.height ? image.width / image.height : null;
  return (
    <button
      type="button"
      className="msg-image"
      onClick={onOpen}
      style={ratio ? { aspectRatio: String(ratio) } : undefined}
      title={image.description ?? '查看大圖'}
      aria-label={image.description ? `照片：${image.description}` : '查看大圖'}
    >
      <img src={image.url} alt={image.description ?? ''} loading="lazy" />
    </button>
  );
}

function ImageViewer({ image, onClose }: { image: MessageImageDto; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className="image-viewer" onClose={onClose} onClick={onClose} aria-label="圖片">
      <img src={image.url} alt={image.description ?? ''} />
      {image.description && <p>{image.description}</p>}
      <a className="btn btn-small" href={image.url} download onClick={(e) => e.stopPropagation()}>
        下載
      </a>
    </dialog>
  );
}
