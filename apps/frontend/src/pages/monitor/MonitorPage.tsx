import { NavLink, Navigate, Route, Routes } from 'react-router';
import { EventsTab } from './EventsTab.tsx';
import { PreviewTab } from './PreviewTab.tsx';
import { QueueTab } from './QueueTab.tsx';
import { RetrievalTab } from './RetrievalTab.tsx';
import { TraceDetail, TracesTab } from './TracesTab.tsx';
import { UsageTab } from './UsageTab.tsx';

const TABS = [
  { to: 'events', label: '事件' },
  { to: 'traces', label: 'LLM 呼叫' },
  { to: 'queue', label: '佇列與排程' },
  { to: 'preview', label: 'Prompt 預覽' },
  { to: 'retrieval', label: '記憶檢索' },
  { to: 'usage', label: '用量' },
];

export function MonitorPage() {
  return (
    <div className="two-pane has-selection settings monitor">
      <aside className="chat-list settings-nav" aria-label="監控分類">
        <div className="chat-list-head">
          <h1 className="pane-title">監控</h1>
        </div>
        <nav className="settings-tabs">
          {TABS.map((t) => (
            <NavLink key={t.to} to={`/monitor/${t.to}`} className="settings-tab">
              {t.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="pane-main">
        <Routes>
          <Route index element={<Navigate to="/monitor/events" replace />} />
          <Route path="events" element={<EventsTab />} />
          <Route path="traces" element={<TracesTab />} />
          <Route path="traces/:traceId" element={<TraceDetail />} />
          <Route path="queue" element={<QueueTab />} />
          <Route path="preview" element={<PreviewTab />} />
          <Route path="retrieval" element={<RetrievalTab />} />
          <Route path="usage" element={<UsageTab />} />
        </Routes>
      </main>
    </div>
  );
}
