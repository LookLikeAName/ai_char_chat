// Prompt 預覽：如果現在回覆（或主動發話），會送出什麼。不會呼叫 LLM。
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { JsonView } from '../../components/debug/JsonView.tsx';
import { PromptView } from '../../components/debug/PromptView.tsx';
import { api } from '../../lib/api.ts';
import { errorText, useToast } from '../../lib/toast.tsx';
import { useNames } from './common.ts';

export function PreviewTab() {
  const toast = useToast();
  const { conversations, avatarName } = useNames();
  const [conversationId, setConversationId] = useState('');
  const [avatarId, setAvatarId] = useState('');
  const [mode, setMode] = useState<'reply' | 'proactive'>('reply');
  const selected = conversationId || conversations[0]?.id || '';
  const conv = conversations.find((c) => c.id === selected);
  const isGroup = conv?.type === 'group';
  // 群組要指定以哪個成員的角度組 prompt
  const speaker = isGroup ? (conv.memberAvatarIds.includes(avatarId) ? avatarId : conv.memberAvatarIds[0]) : undefined;
  const { data, refetch, isFetching, error } = useQuery({
    queryKey: ['debug', 'preview', selected, mode, speaker],
    queryFn: () => api.debug.preview(selected, mode, speaker),
    enabled: !!selected,
  });
  const extract = useMutation({
    mutationFn: () => api.debug.extractNow(selected),
    onSuccess: () => toast('已排入記憶萃取', 'success'),
    onError: (err) => toast(errorText(err), 'error'),
  });

  return (
    <div className="monitor-body">
      <header className="editor-head">
        <h1>Prompt 預覽</h1>
      </header>
      <p className="hint">依目前的設定、關係、記憶與作息，組出「現在回覆的話」會送給 LLM 的內容。預覽不會呼叫 LLM，也不會改變任何狀態。</p>
      <div className="filters">
        <select value={selected} onChange={(e) => setConversationId(e.target.value)} aria-label="對話">
          {conversations.map((c) => (
            <option key={c.id} value={c.id}>
              {c.type === 'group' ? `群組：${c.title}` : c.title}
            </option>
          ))}
        </select>
        {isGroup && (
          <select value={speaker} onChange={(e) => setAvatarId(e.target.value)} aria-label="成員">
            {conv.memberAvatarIds.map((id) => (
              <option key={id} value={id}>
                {avatarName(id)}
              </option>
            ))}
          </select>
        )}
        <select value={mode} onChange={(e) => setMode(e.target.value as 'reply' | 'proactive')} aria-label="模式">
          <option value="reply">回覆</option>
          <option value="proactive">主動發話</option>
        </select>
        <button className="btn btn-small" onClick={() => void refetch()} disabled={isFetching}>
          {isFetching ? '組合中…' : '重新整理'}
        </button>
        <button className="btn btn-small btn-ghost" onClick={() => extract.mutate()} disabled={!selected}>
          立刻整理這個對話的記憶
        </button>
      </div>
      {error && <p className="warn-text">{errorText(error)}</p>}
      {data && (
        <>
          <section className="card">
            <h3>條件</h3>
            <JsonView value={data.notes} />
          </section>
          <section className="card">
            <PromptView system={data.system} messages={data.messages} />
          </section>
        </>
      )}
    </div>
  );
}
