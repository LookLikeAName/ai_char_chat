// LLM 呼叫：列表（即時更新）與單筆的完整 context。
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { MANUAL_RETRY_HINTS, RETRYABLE_PURPOSES, type TraceSummaryDto } from '@acc/shared';
import { JsonView } from '../../components/debug/JsonView.tsx';
import { PromptView } from '../../components/debug/PromptView.tsx';
import { Icon } from '../../components/Icon.tsx';
import { api } from '../../lib/api.ts';
import { useDebugStream } from '../../lib/serverEvents.tsx';
import { errorText, useToast } from '../../lib/toast.tsx';
import { clock, PURPOSE_LABELS, useNames } from './common.ts';

export function TracesTab() {
  const toast = useToast();
  const { avatars, avatarName } = useNames();
  const [rows, setRows] = useState<TraceSummaryDto[]>([]);
  const [purpose, setPurpose] = useState('');
  const [avatarId, setAvatarId] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api.debug
      .traces({ purpose: purpose || undefined, avatarId: avatarId || undefined, failed: failed ? 'true' : undefined })
      .then(setRows)
      .catch((err) => toast(errorText(err), 'error'));
  }, [purpose, avatarId, failed, toast]);

  useDebugStream((m) => {
    if (m.kind !== 'trace') return;
    const t = m.trace;
    // 新的成功：之前同一件事失敗的呼叫就不用重來了
    if (t.ok) setRows((r) => r.map((x) => (!x.ok && sameTask(x, t) ? { ...x, retry: 'superseded' } : x)));
    if ((purpose && t.purpose !== purpose) || (avatarId && t.avatarId !== avatarId) || (failed && t.ok)) return;
    const row = t.ok ? t : { ...t, retry: t.purpose in RETRYABLE_PURPOSES ? ('available' as const) : ('manual' as const) };
    setRows((r) => [row, ...r].slice(0, 500));
  });

  return (
    <div className="monitor-body">
      <header className="editor-head">
        <h1>LLM 呼叫</h1>
        <span className="live-dot" aria-hidden />
        <span className="hint">每次呼叫的完整 context 與回應</span>
      </header>
      <div className="filters">
        <select value={purpose} onChange={(e) => setPurpose(e.target.value)} aria-label="用途">
          <option value="">所有用途</option>
          {Object.entries(PURPOSE_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
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
        <label className="check">
          <input type="checkbox" checked={failed} onChange={(e) => setFailed(e.target.checked)} />
          <span>只看失敗</span>
        </label>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>時間</th>
              <th>用途</th>
              <th>avatar</th>
              <th>模型</th>
              <th className="num">輸入</th>
              <th className="num">輸出</th>
              <th className="num">延遲</th>
              <th>結果</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="hint">
                  還沒有紀錄。
                </td>
              </tr>
            )}
            {rows.map((t) => (
              <tr key={t.id}>
                <td>
                  <Link to={`/monitor/traces/${t.id}`}>{clock(t.createdAt)}</Link>
                </td>
                <td>{PURPOSE_LABELS[t.purpose] ?? t.purpose}</td>
                <td>{avatarName(t.avatarId)}</td>
                <td className="mono">{t.model}</td>
                <td className="num">{t.inputTokens.toLocaleString()}</td>
                <td className="num">{t.outputTokens.toLocaleString()}</td>
                <td className="num">{(t.latencyMs / 1000).toFixed(1)}s</td>
                <td>{t.ok ? <span className="ok-text">成功</span> : <span className="warn-text" title={t.error ?? ''}>失敗</span>}</td>
                <td>{!t.ok && <RetryButton trace={t} compact />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** 同一件事：同用途、同 avatar、同對話 */
function sameTask(a: TraceSummaryDto, b: TraceSummaryDto): boolean {
  return a.purpose === b.purpose && a.avatarId === b.avatarId && a.conversationId === b.conversationId && b.createdAt > a.createdAt;
}

/** 失敗的呼叫：還沒有後續成功的話可以重新觸發；不能從這裡觸發的顯示該去哪裡 */
function RetryButton({ trace, compact = false }: { trace: TraceSummaryDto; compact?: boolean }) {
  const toast = useToast();
  const [state, setState] = useState<'idle' | 'pending' | 'done'>('idle');
  if (trace.retry === 'superseded') return <span className="hint">{compact ? '已有後續成功' : '之後已經有同一件事成功的呼叫，不需要重來'}</span>;
  if (trace.retry === 'manual' || !trace.retry) {
    const hint = MANUAL_RETRY_HINTS[trace.purpose] ?? '在原本的畫面重新操作';
    return compact ? <span className="hint" title={hint}>—</span> : <span className="hint">{hint}</span>;
  }
  return (
    <span className="row">
      <button
        type="button"
        className="btn btn-small"
        disabled={state !== 'idle'}
        title={RETRYABLE_PURPOSES[trace.purpose]}
        onClick={async () => {
          setState('pending');
          try {
            const r = await api.debug.retryTrace(trace.id);
            toast(r.message, 'success');
            setState('done');
          } catch (err) {
            toast(errorText(err), 'error');
            setState('idle');
          }
        }}
      >
        {state === 'pending' ? '處理中…' : state === 'done' ? '已重新觸發' : '重新呼叫'}
      </button>
      {!compact && <span className="hint">{RETRYABLE_PURPOSES[trace.purpose]}</span>}
    </span>
  );
}

export function TraceDetail() {
  const { traceId } = useParams();
  const { avatarName, conversationName } = useNames();
  const { data: t, error } = useQuery({ queryKey: ['trace', traceId], queryFn: () => api.debug.trace(traceId!) });

  return (
    <div className="monitor-body">
      <header className="editor-head">
        <Link to="/monitor/traces" className="icon-btn" aria-label="返回列表">
          <Icon name="back" />
        </Link>
        <h1>LLM 呼叫</h1>
      </header>
      {error && <p className="warn-text">{errorText(error)}</p>}
      {t && (
        <>
          <section className="card">
            <dl className="kv">
              <dt>時間</dt>
              <dd>{new Date(t.createdAt).toLocaleString('zh-TW', { hour12: false })}</dd>
              <dt>用途</dt>
              <dd>{PURPOSE_LABELS[t.purpose] ?? t.purpose}</dd>
              {t.avatarId && (
                <>
                  <dt>avatar</dt>
                  <dd>{avatarName(t.avatarId)}</dd>
                </>
              )}
              {t.conversationId && (
                <>
                  <dt>對話</dt>
                  <dd>
                    <Link to={`/chats/${t.conversationId}`}>{conversationName(t.conversationId)}</Link>
                  </dd>
                </>
              )}
              <dt>模型</dt>
              <dd className="mono">
                {t.provider} · {t.model}
              </dd>
              <dt>參數</dt>
              <dd className="mono">{JSON.stringify(t.params)}</dd>
              <dt>tokens</dt>
              <dd>
                輸入 {t.inputTokens.toLocaleString()}、輸出 {t.outputTokens.toLocaleString()}
              </dd>
              <dt>延遲</dt>
              <dd>{(t.latencyMs / 1000).toFixed(2)} 秒</dd>
              <dt>結果</dt>
              <dd>{t.ok ? <span className="ok-text">成功</span> : <span className="warn-text">失敗：{t.error}</span>}</dd>
              {!t.ok && (
                <>
                  <dt>重新呼叫</dt>
                  <dd>
                    <RetryButton trace={t} />
                  </dd>
                </>
              )}
            </dl>
          </section>
          {t.request.messages.length || t.request.system ? (
            <section className="card">
              <PromptView system={t.request.system} messages={t.request.messages} />
              {t.request.json && <p className="hint">要求 JSON 輸出</p>}
            </section>
          ) : (
            <p className="hint">這筆呼叫沒有記錄完整 context（設定 → 一般 → 除錯）。</p>
          )}
          {t.response !== null && (
            <section className="card">
              <h3>原始回應</h3>
              <JsonView value={t.response} />
            </section>
          )}
          {t.parsed !== null && t.parsed !== undefined && (
            <section className="card">
              <h3>解析結果</h3>
              <JsonView value={t.parsed} />
            </section>
          )}
        </>
      )}
    </div>
  );
}
