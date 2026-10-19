import { useQuery } from '@tanstack/react-query';
import { api, qk } from '../../lib/api.ts';
import { useWsStatus } from '../../lib/serverEvents.tsx';

function Status({ ok, label, detail }: { ok: boolean; label: string; detail?: string }) {
  return (
    <li className="status-row">
      <span className={`status-dot ${ok ? 'ok' : 'bad'}`} aria-hidden />
      <span>{label}</span>
      <span className="hint">{detail ?? (ok ? '正常' : '異常')}</span>
    </li>
  );
}

export function SystemStatus() {
  const ws = useWsStatus();
  const { data, error } = useQuery({ queryKey: qk.health, queryFn: api.health, refetchInterval: 10_000 });
  return (
    <div className="editor">
      <header className="editor-head">
        <h1>系統狀態</h1>
      </header>
      <section className="card">
        {error && <p className="warn-text">無法連到後端：{String(error)}</p>}
        <ul className="status-list">
          <Status ok={!!data?.db} label="資料庫（PostgreSQL）" />
          <Status ok={!!data?.redis} label="佇列（Redis）" />
          <Status
            ok={!!data?.worker.online}
            label="Worker"
            detail={
              data?.worker.lastSeen
                ? `最後心跳 ${new Date(data.worker.lastSeen).toLocaleTimeString('zh-TW', { hour12: false })}`
                : '沒有心跳'
            }
          />
          <Status ok={ws === 'open'} label="即時連線（WebSocket）" detail={ws === 'open' ? '已連線' : '重新連線中…'} />
        </ul>
        {data && <p className="hint">版本 {data.version}</p>}
      </section>
    </div>
  );
}
