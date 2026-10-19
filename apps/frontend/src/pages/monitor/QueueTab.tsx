// 佇列與排程：工作數量、每個對話預計什麼時候看到、延遲中與失敗的工作，以及手動操作。
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SEEN_REASON_LABELS, type QueueJobDto, type SeenReason } from '@acc/shared';
import { api } from '../../lib/api.ts';
import { errorText, useToast } from '../../lib/toast.tsx';
import { clock, relative, useNames } from './common.ts';

const COUNT_LABELS: Record<string, string> = {
  waiting: '等待中',
  delayed: '延遲中',
  active: '執行中',
  completed: '已完成',
  failed: '失敗',
};

const KIND_LABELS: Record<string, string> = {
  reply: '回覆',
  'memory.extract': '記憶萃取',
  maintenance: '定期維護',
  'proactive.tick': '主動發話檢查',
  proactive: '主動發話',
};

export function QueueTab() {
  const toast = useToast();
  const qc = useQueryClient();
  const { avatarName, conversationName } = useNames();
  const { data } = useQuery({ queryKey: ['debug', 'queue'], queryFn: api.debug.queue, refetchInterval: 5000 });
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => {
      toast('已送出', 'success');
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['debug', 'queue'] }), 500);
    },
    onError: (err) => toast(errorText(err), 'error'),
  });

  const target = (j: QueueJobDto) => {
    const d = j.data as { avatarId?: string; conversationId?: string; force?: boolean };
    const a = d.avatarId ? avatarName(d.avatarId) : '';
    const c = d.conversationId ? conversationName(d.conversationId) : '';
    // 一對一的對話名稱就是 avatar 名稱，不重複顯示
    return [a, c !== a ? c : '', d.force ? '（強制）' : ''].filter(Boolean).join(' · ');
  };

  return (
    <div className="monitor-body">
      <header className="editor-head">
        <h1>佇列與排程</h1>
        <span className="spacer" />
        <button className="btn btn-small" onClick={() => act.mutate(() => api.debug.run('proactive-tick'))}>
          立刻跑主動發話檢查
        </button>
        <button className="btn btn-small" onClick={() => act.mutate(() => api.debug.run('maintenance'))}>
          立刻跑定期維護
        </button>
      </header>

      <div className="tiles">
        {Object.entries(COUNT_LABELS).map(([k, label]) => (
          <div key={k} className={`tile${k === 'failed' && (data?.counts[k] ?? 0) > 0 ? ' tile-warn' : ''}`}>
            <span className="tile-label">{label}</span>
            <span className="tile-value">{data?.counts[k] ?? '—'}</span>
          </div>
        ))}
      </div>

      <section className="card">
        <h2>預計看到訊息的時間</h2>
        <p className="hint">玩家傳了訊息、avatar 還沒看到的對話。時間到了 worker 才會處理。</p>
        {!data?.replyPlans.length ? (
          <p className="hint">目前沒有等待中的回覆。</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>avatar</th>
                <th>原因</th>
                <th>預計</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.replyPlans.map((p) => (
                <tr key={`${p.conversationId}-${p.avatarId}`}>
                  <td>{p.avatarName}</td>
                  <td>{p.reason ? (SEEN_REASON_LABELS[p.reason as SeenReason] ?? p.reason) : ''}</td>
                  <td>
                    {clock(p.dueAt)}（{relative(p.dueAt, now)}）
                  </td>
                  <td className="num">
                    <button className="btn btn-small" onClick={() => act.mutate(() => api.debug.replyNow(p.conversationId))}>
                      立刻回覆
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <JobTable
        title="延遲中的工作"
        jobs={data?.delayed ?? []}
        empty="沒有延遲中的工作。"
        render={(j) => (
          <>
            <td>{KIND_LABELS[j.kind] ?? j.kind}</td>
            <td>{target(j)}</td>
            <td>
              {clock(j.at)}（{relative(j.at, now)}）
            </td>
            <td className="num">
              <button className="btn btn-small" onClick={() => act.mutate(() => api.debug.promote(j.id))}>
                立刻執行
              </button>
            </td>
          </>
        )}
        headers={['工作', '對象', '預計執行', '']}
      />
      <JobTable
        title="執行中"
        jobs={data?.active ?? []}
        empty="沒有執行中的工作。"
        headers={['工作', '對象', '開始']}
        render={(j) => (
          <>
            <td>{KIND_LABELS[j.kind] ?? j.kind}</td>
            <td>{target(j)}</td>
            <td>{clock(j.at)}</td>
          </>
        )}
      />
      <JobTable
        title="最近失敗"
        jobs={data?.failed ?? []}
        empty="沒有失敗的工作。"
        headers={['工作', '對象', '時間', '原因']}
        render={(j) => (
          <>
            <td>{KIND_LABELS[j.kind] ?? j.kind}</td>
            <td>{target(j)}</td>
            <td>{clock(j.at)}</td>
            <td className="warn-text">{j.failedReason}</td>
          </>
        )}
      />
    </div>
  );
}

function JobTable({
  title,
  jobs,
  empty,
  headers,
  render,
}: {
  title: string;
  jobs: QueueJobDto[];
  empty: string;
  headers: string[];
  render: (j: QueueJobDto) => React.ReactNode;
}) {
  return (
    <section className="card">
      <h2>
        {title}（{jobs.length}）
      </h2>
      {jobs.length === 0 ? (
        <p className="hint">{empty}</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                {headers.map((h, i) => (
                  <th key={i}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>{render(j)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
