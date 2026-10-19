// 記憶檢索測試：這段話會讓 avatar 想起哪些記憶，以及分數的組成。
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../lib/api.ts';
import { errorText, useToast } from '../../lib/toast.tsx';
import { clock, useNames } from './common.ts';

function Bar({ value, label }: { value: number; label: string }) {
  return (
    <span className="score-bar" title={`${label} ${value}`}>
      <span style={{ width: `${Math.max(2, value * 100)}%` }} />
    </span>
  );
}

export function RetrievalTab() {
  const toast = useToast();
  const { avatars } = useNames();
  const [avatarId, setAvatarId] = useState('');
  const [query, setQuery] = useState('');
  const selected = avatarId || avatars[0]?.id || '';
  const run = useMutation({
    mutationFn: () => api.debug.retrieve(selected, query),
    onError: (err) => toast(errorText(err), 'error'),
  });

  return (
    <div className="monitor-body">
      <header className="editor-head">
        <h1>記憶檢索</h1>
      </header>
      <p className="hint">
        分數 = 0.5 × 相關度 + 0.25 × 新近度 + 0.25 × 重要性。回覆時取前 8 筆；這裡顯示前 15 筆，且不會更新記憶的取用時間。
      </p>
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          if (selected) run.mutate();
        }}
      >
        <select value={selected} onChange={(e) => setAvatarId(e.target.value)} aria-label="avatar">
          {avatars.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <input
          className="grow"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="輸入玩家可能說的話，例如：面試結果出來了"
          aria-label="查詢"
        />
        <button className="btn btn-small btn-primary" type="submit" disabled={run.isPending || !selected}>
          檢索
        </button>
      </form>
      {run.data && (
        <section className="card">
          <p className="hint">{run.data.embedder ? `嵌入模型：${run.data.embedder}` : '沒有設定嵌入模型：相關度用字元雙連詞比對'}</p>
          {run.data.rows.length === 0 ? (
            <p className="hint">這個 avatar 還沒有記憶。</p>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>記憶</th>
                    <th>相關度</th>
                    <th>新近度</th>
                    <th className="num">重要性</th>
                    <th className="num">分數</th>
                  </tr>
                </thead>
                <tbody>
                  {run.data.rows.map((r, i) => (
                    <tr key={r.id} className={i < 8 ? '' : 'dim'}>
                      <td>{i + 1}</td>
                      <td>
                        {r.content}
                        <div className="hint">{clock(r.createdAt)}</div>
                      </td>
                      <td>
                        <Bar value={r.relevance} label="相關度" /> {r.relevance.toFixed(2)}
                      </td>
                      <td>
                        <Bar value={r.recency} label="新近度" /> {r.recency.toFixed(2)}
                      </td>
                      <td className="num">{r.importance}</td>
                      <td className="num">
                        <b>{r.score.toFixed(3)}</b>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
