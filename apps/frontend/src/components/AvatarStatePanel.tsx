// 資訊面板的動態狀態：心情、關係、印象、記憶。
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { EVENT_LABELS, INTIMACY_LABELS, STAGE_LABELS, utilityBinding, type Mood } from '@acc/shared';
import { api, qk } from '../lib/api.ts';
import { shortTime } from '../lib/format.ts';
import { errorText, useToast } from '../lib/toast.tsx';
import { RelationshipAdjust } from './RelationshipAdjust.tsx';

function moodEmoji(m: Mood): string {
  if (m.valence >= 3) return '😄';
  if (m.valence >= 1) return '🙂';
  if (m.valence <= -3) return '😣';
  if (m.valence <= -1) return '😕';
  return m.energy <= -2 ? '😪' : '😐';
}

/** 單一數值的量表：填色與軌道同一色相；好感可以是負的，所以從中線往兩側長 */
function Meter({ label, value, min, max }: { label: string; value: number; min: number; max: number }) {
  const diverging = min < 0;
  const pct = ((value - min) / (max - min)) * 100;
  const style = diverging
    ? value >= 0
      ? { left: '50%', width: `${pct - 50}%` }
      : { left: `${pct}%`, width: `${50 - pct}%` }
    : { left: 0, width: `${pct}%` };
  return (
    <div className="meter" title={`${label} ${value}（${min}～${max}）`}>
      <div className="meter-head">
        <span>{label}</span>
        <span className="meter-value">{value}</span>
      </div>
      <div className="meter-track" role="meter" aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
        {diverging && <span className="meter-mid" />}
        <span className={`meter-fill${value < 0 ? ' neg' : ''}`} style={style} />
      </div>
    </div>
  );
}

export function AvatarStatePanel({ avatarId }: { avatarId: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: state } = useQuery({ queryKey: qk.avatarState(avatarId), queryFn: () => api.avatarState(avatarId) });
  const { data: settings } = useQuery({ queryKey: qk.settings, queryFn: api.settings });
  const canRemember = !!settings && !!utilityBinding(settings, 'memory');
  const [showAll, setShowAll] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: qk.avatarState(avatarId) });

  const forget = useMutation({
    mutationFn: (memoryId: string) => api.deleteMemory(avatarId, memoryId),
    onSuccess: refresh,
    onError: (err) => toast(errorText(err), 'error'),
  });
  const reflect = useMutation({
    mutationFn: () => api.reflectNow(avatarId),
    onSuccess: (r) => {
      refresh();
      toast(r.updated ? '印象已更新' : '還沒有新的記憶可以整理', r.updated ? 'success' : 'info');
    },
    onError: (err) => toast(errorText(err), 'error'),
  });

  if (!state) return <p className="hint">載入中…</p>;
  const memories = showAll ? state.memories : state.memories.slice(0, 5);
  const events = [...state.relationship.events].reverse().slice(0, 5);

  return (
    <dl className="info-list">
      <dt>心情</dt>
      <dd className="mood">
        <span className="mood-emoji" aria-hidden>
          {moodEmoji(state.mood)}
        </span>
        <span>{state.mood.label}</span>
      </dd>

      <dt>關係</dt>
      <dd>
        <span className={`stage stage-${state.relationship.stage}`}>{STAGE_LABELS[state.relationship.stage]}</span>
        <Meter label="好感" value={state.relationship.affinity} min={-100} max={100} />
        <Meter label="信任" value={state.relationship.trust} min={0} max={100} />
        {/* 心動：有一點點以後才出現 */}
        {(state.relationship.romance ?? 0) > 0 && <Meter label="心動" value={state.relationship.romance ?? 0} min={0} max={100} />}
        {events.length > 0 && (
          <ul className="rel-events">
            {events.map((e, i) => (
              <li key={i}>
                <span className="hint">{shortTime(e.at)}</span> {e.note || EVENT_LABELS[e.type]}
                {e.from && e.to && (
                  <span className="hint">
                    （{STAGE_LABELS[e.from]} → {STAGE_LABELS[e.to]}）
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {state.intimacy && (
          <p className="hint">
            親密的尺度現在最多到：<strong>{INTIMACY_LABELS[state.intimacy]}</strong>（依關係、好感與信任、它的開放程度與心情）
          </p>
        )}
        <details className="rel-reset">
          <summary className="hint">調整關係</summary>
          <RelationshipAdjust
            key={`${state.relationship.stage}:${state.relationship.affinity}:${state.relationship.trust}:${state.relationship.romance}`}
            avatarId={avatarId}
            current={state.relationship}
          />
        </details>
      </dd>

      {state.today.length > 0 && (
        <>
          <dt>今天</dt>
          <dd>
            <ul className="today">
              {state.today.map((e, i) => (
                <li key={i}>
                  <span className="hint">{e.time}</span> {e.text}
                </li>
              ))}
            </ul>
          </dd>
        </>
      )}

      <dt>對你的印象</dt>
      <dd>
        {state.impression ? <p className="impression">{state.impression}</p> : <span className="hint">還沒有整理過。</span>}
        {canRemember && (
          <button className="btn btn-small btn-ghost" onClick={() => reflect.mutate()} disabled={reflect.isPending}>
            {reflect.isPending ? '整理中…' : '現在整理'}
          </button>
        )}
      </dd>

      <dt>它記得你的事</dt>
      <dd>
        {state.memories.length === 0 ? (
          <span className="hint">
            {canRemember ? '聊天告一段落（約 10 分鐘沒有新訊息）後會整理記憶。' : '設定系統工具模型後才會整理記憶。'}
          </span>
        ) : (
          <ul className="memories">
            {memories.map((m) => (
              <li key={m.id}>
                <span className="memory-text">{m.content}</span>
                <button
                  className="icon-btn memory-forget"
                  onClick={() => forget.mutate(m.id)}
                  aria-label={`讓它忘記：${m.content}`}
                  title="讓它忘記這件事"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        {state.memories.length > 5 && (
          <button className="link-btn hint" onClick={() => setShowAll((v) => !v)}>
            {showAll ? '收起' : `顯示全部 ${state.memories.length} 件`}
          </button>
        )}
      </dd>
      <dt>今天的用量</dt>
      <dd>
        <span className="hint">
          {state.usageToday.tokens.toLocaleString()} tokens
          {state.usageToday.costUsd > 0 && `（約 $${state.usageToday.costUsd.toFixed(state.usageToday.costUsd < 0.01 ? 4 : 2)}）`}
          {state.usageToday.limit > 0 && `，上限 ${state.usageToday.limit.toLocaleString()}`}
        </span>
        {(state.usageToday.limit > 0 && state.usageToday.tokens >= state.usageToday.limit) ||
        (state.usageToday.globalLimit > 0 && state.usageToday.globalTokens >= state.usageToday.globalLimit) ? (
          <span className="warn-text">已達上限，今天暫時不會回覆</span>
        ) : null}
        <Link className="hint" to="/settings/usage">
          用量統計 →
        </Link>
      </dd>
      <dt>除錯</dt>
      <dd>
        <Link className="hint" to="/monitor/events">
          在監控頁查看事件與 LLM 呼叫 →
        </Link>
      </dd>
    </dl>
  );
}

