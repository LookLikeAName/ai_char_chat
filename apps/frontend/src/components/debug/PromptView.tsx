// 顯示送給 LLM 的 context：system prompt 依「#」標題分段（可收合），對話訊息依角色排列。
import { useState } from 'react';
import { CopyButton } from './JsonView.tsx';

interface Props {
  system?: string;
  messages: { role: string; content: string }[];
}

function splitSections(system: string): { title: string; body: string }[] {
  const out: { title: string; body: string }[] = [];
  let cur = { title: '（開頭）', body: '' };
  for (const line of system.split('\n')) {
    if (/^# /.test(line)) {
      if (cur.body.trim() || cur.title !== '（開頭）') out.push(cur);
      cur = { title: line.slice(2), body: '' };
    } else {
      cur.body += `${line}\n`;
    }
  }
  out.push(cur);
  return out.filter((s) => s.body.trim() || s.title !== '（開頭）');
}

export function PromptView({ system, messages }: Props) {
  const sections = system ? splitSections(system) : [];
  const [allOpen, setAllOpen] = useState(true);
  const full = JSON.stringify({ system, messages }, null, 2);
  return (
    <div className="prompt-view">
      <div className="row">
        <h3>System prompt</h3>
        <span className="hint">{system ? `${system.length.toLocaleString()} 字` : '（沒有）'}</span>
        <span className="spacer" />
        <button type="button" className="btn btn-small btn-ghost" onClick={() => setAllOpen((v) => !v)}>
          {allOpen ? '全部收合' : '全部展開'}
        </button>
        <CopyButton text={system ?? ''} label="複製 system" />
        <CopyButton text={full} label="複製全部（JSON）" />
      </div>
      {sections.map((s, i) => (
        <details key={`${i}-${allOpen}`} className="prompt-section" open={allOpen}>
          <summary>{s.title}</summary>
          <pre>{s.body.trim()}</pre>
        </details>
      ))}
      <h3>對話訊息（{messages.length}）</h3>
      <ol className="prompt-messages">
        {messages.map((m, i) => (
          <li key={i} className={`pm pm-${m.role}`}>
            <span className="pm-role">{m.role}</span>
            <pre>{m.content}</pre>
          </li>
        ))}
      </ol>
    </div>
  );
}
