// 用量：今天與上限、每天的用量、依 avatar／用途／模型分組。費用依 LLM 設定檔填的價格估算。
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { totalTokens, USAGE_PURPOSE_LABELS, type UsageTotals } from '@acc/shared';
import { AvatarImage } from '../../components/AvatarImage.tsx';
import { api, qk } from '../../lib/api.ts';

const RANGES = [7, 30, 90];

export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function usd(n: number): string {
  if (!n) return '$0';
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function LimitBar({ used, limit }: { used: number; limit: number }) {
  if (!limit) return <span className="hint">不限</span>;
  const ratio = Math.min(1, used / limit);
  return (
    <span className="limit-bar" title={`${used.toLocaleString()}／${limit.toLocaleString()} tokens`}>
      <span className="limit-track">
        <span className={`limit-fill${ratio >= 1 ? ' over' : ratio >= 0.8 ? ' near' : ''}`} style={{ width: `${ratio * 100}%` }} />
      </span>
      <span className="limit-text">
        {compactTokens(used)}／{compactTokens(limit)}
      </span>
    </span>
  );
}

function Cells({ t, priced }: { t: UsageTotals; priced: boolean }) {
  return (
    <>
      <td className="num">{t.calls.toLocaleString()}</td>
      <td className="num">{t.failed ? <span className="warn-text">{t.failed}</span> : 0}</td>
      <td className="num">{compactTokens(t.inputTokens)}</td>
      <td className="num">{compactTokens(t.outputTokens)}</td>
      {priced && <td className="num">{usd(t.costUsd)}</td>}
    </>
  );
}

export function UsageSettings() {
  const [days, setDays] = useState(30);
  const { data } = useQuery({ queryKey: ['usage', days], queryFn: () => api.usage(days), refetchInterval: 60_000 });
  const { data: avatars = [] } = useQuery({ queryKey: qk.avatars, queryFn: api.avatars });
  const { data: profiles = [] } = useQuery({ queryKey: qk.llmProfiles, queryFn: api.llmProfiles });
  if (!data) return <p className="hint pad">載入中…</p>;

  const priced = profiles.some((p) => p.pricing) || data.total.costUsd > 0;
  const head = (
    <>
      <th className="num">次數</th>
      <th className="num">失敗</th>
      <th className="num">輸入</th>
      <th className="num">輸出</th>
      {priced && <th className="num">費用</th>}
    </>
  );
  const peak = Math.max(1, ...data.daily.map(totalTokens));
  const todayTokens = totalTokens(data.today);
  // 有上限但這段期間沒用量的 avatar 也列出來
  const rows = [
    ...data.byAvatar,
    ...avatars
      .filter((a) => !data.byAvatar.some((r) => r.avatarId === a.id))
      .map((a) => ({ avatarId: a.id, todayTokens: 0, limit: a.dailyTokenLimit, calls: 0, failed: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 })),
  ];

  return (
    <div className="editor">
      <header className="editor-head">
        <h1>用量</h1>
        <span className="spacer" />
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="期間">
          {RANGES.map((d) => (
            <option key={d} value={d}>
              最近 {d} 天
            </option>
          ))}
        </select>
      </header>

      <div className="tiles">
        <div className={`tile${data.today.limit && todayTokens >= data.today.limit ? ' tile-warn' : ''}`}>
          <span className="tile-label">今天</span>
          <span className="tile-value">{compactTokens(todayTokens)}</span>
          <LimitBar used={todayTokens} limit={data.today.limit} />
        </div>
        {priced && (
          <div className="tile">
            <span className="tile-label">今天的費用</span>
            <span className="tile-value">{usd(data.today.costUsd)}</span>
          </div>
        )}
        <div className="tile">
          <span className="tile-label">最近 {days} 天</span>
          <span className="tile-value">{compactTokens(totalTokens(data.total))}</span>
          <span className="hint">{data.total.calls.toLocaleString()} 次呼叫</span>
        </div>
        {priced && (
          <div className="tile">
            <span className="tile-label">最近 {days} 天的費用</span>
            <span className="tile-value">{usd(data.total.costUsd)}</span>
          </div>
        )}
      </div>
      {!priced && (
        <p className="hint">
          想看費用的話，在 <Link to="/settings/llm">LLM 設定檔</Link> 填上價格。上限在 <Link to="/settings/general">一般 → 費用</Link>{' '}
          與每個 avatar 的「大腦」設定。
        </p>
      )}

      <section className="card">
        <h2>每天</h2>
        <div className="day-chart" role="img" aria-label={`最近 ${days} 天每天的 token 用量`}>
          {data.daily.map((d) => {
            const t = totalTokens(d);
            return (
              <span
                key={d.date}
                className="day-bar"
                title={`${d.date}：${t.toLocaleString()} tokens${priced ? `，${usd(d.costUsd)}` : ''}（${d.calls} 次）`}
              >
                <span className="day-bar-fill" style={{ height: `${(t / peak) * 100}%` }} />
              </span>
            );
          })}
        </div>
        <div className="day-chart-axis">
          <span>{data.daily[0]?.date.slice(5)}</span>
          <span>最高 {compactTokens(peak)}</span>
          <span>今天</span>
        </div>
      </section>

      <section className="card">
        <h2>每個 avatar</h2>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>avatar</th>
                <th>今天／上限</th>
                {head}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const a = avatars.find((x) => x.id === r.avatarId);
                return (
                  <tr key={r.avatarId ?? 'system'}>
                    <td>
                      {r.avatarId ? (
                        <Link className="usage-who" to={`/avatars/${r.avatarId}`}>
                          <AvatarImage name={a?.name ?? '?'} src={a?.imageUrl ?? null} size={24} />
                          {a?.name ?? '（已刪除）'}
                        </Link>
                      ) : (
                        <span className="hint">系統工具（補完角色、玩家摘要）</span>
                      )}
                    </td>
                    <td>{r.avatarId ? <LimitBar used={r.todayTokens} limit={r.limit} /> : <span className="hint">—</span>}</td>
                    <Cells t={r} priced={priced} />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="hint">avatar 的用量包含回覆、主動發話、整理它的記憶與印象、生活日誌。</p>
      </section>

      <section className="card">
        <h2>用途</h2>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>用途</th>
                {head}
              </tr>
            </thead>
            <tbody>
              {data.byPurpose.map((r) => (
                <tr key={r.purpose}>
                  <td>{USAGE_PURPOSE_LABELS[r.purpose] ?? r.purpose}</td>
                  <Cells t={r} priced={priced} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>模型</h2>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>模型</th>
                <th>設定檔</th>
                {head}
              </tr>
            </thead>
            <tbody>
              {data.byModel.map((r) => (
                <tr key={`${r.model}-${r.profileId}`}>
                  <td className="mono">{r.model}</td>
                  <td>{profiles.find((p) => p.id === r.profileId)?.name ?? <span className="hint">（已刪除）</span>}</td>
                  <Cells t={r} priced={priced} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
