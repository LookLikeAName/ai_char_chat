// 事件 log：初始載入最近 200 筆，之後即時推進來；可以篩選、暫停、展開看資料。
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { CATEGORY_LABELS, EVENT_CATEGORIES, type DebugEventDto, type EventCategory, type EventLevel } from '@acc/shared';
import { JsonView } from '../../components/debug/JsonView.tsx';
import { api } from '../../lib/api.ts';
import { useDebugStream } from '../../lib/serverEvents.tsx';
import { errorText, useToast } from '../../lib/toast.tsx';
import { clock, useNames } from './common.ts';

const LEVELS: EventLevel[] = ['debug', 'info', 'warn', 'error'];
const RANK: Record<EventLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MAX_ROWS = 1000;

export function EventsTab() {
  const toast = useToast();
  const { avatars, avatarName, conversationName } = useNames();
  const [rows, setRows] = useState<DebugEventDto[]>([]);
  const [category, setCategory] = useState<EventCategory | ''>('');
  const [level, setLevel] = useState<EventLevel>('info');
  const [avatarId, setAvatarId] = useState('');
  const [q, setQ] = useState('');
  const [paused, setPaused] = useState(false);
  const [buffer, setBuffer] = useState<DebugEventDto[]>([]);
  const [open, setOpen] = useState<Set<number>>(new Set());

  // 篩選條件改變時重新從伺服器載入
  useEffect(() => {
    const t = setTimeout(() => {
      api.debug
        .events({ category: category || undefined, level, avatarId: avatarId || undefined, q: q || undefined, limit: '200' })
        .then(setRows)
        .catch((err) => toast(errorText(err), 'error'));
    }, 250);
    return () => clearTimeout(t);
  }, [category, level, avatarId, q, toast]);

  const matches = useMemo(
    () => (e: DebugEventDto) =>
      (!category || e.category === category) &&
      RANK[e.level] >= RANK[level] &&
      (!avatarId || e.avatarId === avatarId) &&
      (!q || e.message.includes(q)),
    [category, level, avatarId, q],
  );

  useDebugStream((m) => {
    if (m.kind !== 'event' || !matches(m.event)) return;
    if (paused) setBuffer((b) => [m.event, ...b]);
    else setRows((r) => [m.event, ...r].slice(0, MAX_ROWS));
  });

  const resume = () => {
    setRows((r) => [...buffer, ...r].slice(0, MAX_ROWS));
    setBuffer([]);
    setPaused(false);
  };

  const toggle = (id: number) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="monitor-body">
      <header className="editor-head">
        <h1>事件</h1>
        <span className="live-dot" aria-hidden />
        <span className="hint">{paused ? `已暫停（${buffer.length} 筆新事件）` : '即時更新中'}</span>
        <span className="spacer" />
        {paused ? (
          <button className="btn btn-small btn-primary" onClick={resume}>
            繼續
          </button>
        ) : (
          <button className="btn btn-small" onClick={() => setPaused(true)}>
            暫停
          </button>
        )}
        <button className="btn btn-small btn-ghost" onClick={() => setRows([])}>
          清空畫面
        </button>
      </header>
      <div className="filters">
        <select value={category} onChange={(e) => setCategory(e.target.value as EventCategory | '')} aria-label="類別">
          <option value="">所有類別</option>
          {EVENT_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
        <select value={level} onChange={(e) => setLevel(e.target.value as EventLevel)} aria-label="最低等級">
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {l === 'debug' ? '全部（含 debug）' : `${l} 以上`}
            </option>
          ))}
        </select>
        <select value={avatarId} onChange={(e) => setAvatarId(e.target.value)} aria-label="avatar">
          <option value="">所有 avatar</option>
          {avatars.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <input type="search" placeholder="搜尋訊息" value={q} onChange={(e) => setQ(e.target.value)} aria-label="搜尋" />
      </div>

      <ol className="event-list">
        {rows.length === 0 && <li className="hint pad">沒有符合的事件。</li>}
        {rows.map((e) => (
          <li key={e.id} className={`event ev-${e.level}`}>
            <button className="event-row" onClick={() => toggle(e.id)} aria-expanded={open.has(e.id)}>
              <time className="event-time">{clock(e.at)}</time>
              <span className={`lvl lvl-${e.level}`}>{e.level}</span>
              <span className="tag">{CATEGORY_LABELS[e.category]}</span>
              {e.avatarId && <span className="event-avatar">{avatarName(e.avatarId)}</span>}
              <span className="event-msg">{e.message}</span>
            </button>
            {open.has(e.id) && (
              <div className="event-detail">
                <div className="row hint">
                  <span>{e.type}</span>
                  {e.conversationId && <span>對話：{conversationName(e.conversationId)}</span>}
                  {e.traceId && <Link to={`/monitor/traces/${e.traceId}`}>查看 LLM 呼叫 →</Link>}
                </div>
                {Object.keys(e.data).length > 0 && <JsonView value={e.data} />}
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
