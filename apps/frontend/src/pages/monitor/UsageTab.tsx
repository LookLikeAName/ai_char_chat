import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.ts';
import { PURPOSE_LABELS } from './common.ts';

const RANGES = [
  { hours: 24, label: '最近 24 小時' },
  { hours: 24 * 7, label: '最近 7 天' },
  { hours: 24 * 30, label: '最近 30 天' },
];

export function UsageTab() {
  const [hours, setHours] = useState(24);
  const { data = [] } = useQuery({ queryKey: ['debug', 'usage', hours], queryFn: () => api.debug.usage(hours) });
  const total = data.reduce(
    (t, r) => ({ calls: t.calls + r.calls, input: t.input + r.inputTokens, output: t.output + r.outputTokens, failed: t.failed + r.failed }),
    { calls: 0, input: 0, output: 0, failed: 0 },
  );
  return (
    <div className="monitor-body">
      <header className="editor-head">
        <h1>用量</h1>
        <span className="spacer" />
        <select value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="期間">
          {RANGES.map((r) => (
            <option key={r.hours} value={r.hours}>
              {r.label}
            </option>
          ))}
        </select>
      </header>
      <div className="tiles">
        <div className="tile">
          <span className="tile-label">呼叫次數</span>
          <span className="tile-value">{total.calls.toLocaleString()}</span>
        </div>
        <div className="tile">
          <span className="tile-label">輸入 tokens</span>
          <span className="tile-value">{total.input.toLocaleString()}</span>
        </div>
        <div className="tile">
          <span className="tile-label">輸出 tokens</span>
          <span className="tile-value">{total.output.toLocaleString()}</span>
        </div>
        <div className={`tile${total.failed ? ' tile-warn' : ''}`}>
          <span className="tile-label">失敗</span>
          <span className="tile-value">{total.failed.toLocaleString()}</span>
        </div>
      </div>
      <section className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>用途</th>
                <th>模型</th>
                <th className="num">次數</th>
                <th className="num">失敗</th>
                <th className="num">輸入</th>
                <th className="num">輸出</th>
                <th className="num">平均延遲</th>
              </tr>
            </thead>
            <tbody>
              {data.length === 0 && (
                <tr>
                  <td colSpan={7} className="hint">
                    這段期間沒有呼叫。
                  </td>
                </tr>
              )}
              {data.map((r) => (
                <tr key={`${r.purpose}-${r.model}`}>
                  <td>{PURPOSE_LABELS[r.purpose] ?? r.purpose}</td>
                  <td className="mono">{r.model}</td>
                  <td className="num">{r.calls.toLocaleString()}</td>
                  <td className="num">{r.failed ? <span className="warn-text">{r.failed}</span> : 0}</td>
                  <td className="num">{r.inputTokens.toLocaleString()}</td>
                  <td className="num">{r.outputTokens.toLocaleString()}</td>
                  <td className="num">{(r.avgLatencyMs / 1000).toFixed(1)}s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
