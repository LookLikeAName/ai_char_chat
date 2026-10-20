import { NavLink, Navigate, Route, Routes } from 'react-router';
import { BackupSettings } from './BackupSettings.tsx';
import { GeneralSettings } from './GeneralSettings.tsx';
import { LlmProfilesSettings } from './LlmProfilesSettings.tsx';
import { SystemStatus } from './SystemStatus.tsx';
import { SecuritySettings } from './SecuritySettings.tsx';
import { UsageSettings } from './UsageSettings.tsx';

const TABS = [
  { to: 'general', label: '一般' },
  { to: 'llm', label: 'LLM 設定檔' },
  { to: 'usage', label: '用量' },
  { to: 'security', label: '安全性' },
  { to: 'backup', label: '備份' },
  { to: 'system', label: '系統狀態' },
];

export function SettingsPage() {
  return (
    <div className="two-pane has-selection settings">
      <aside className="chat-list settings-nav" aria-label="設定分類">
        <div className="chat-list-head">
          <h1 className="pane-title">設定</h1>
        </div>
        <nav className="settings-tabs">
          {TABS.map((t) => (
            <NavLink key={t.to} to={`/settings/${t.to}`} className="settings-tab">
              {t.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="pane-main">
        <Routes>
          <Route index element={<Navigate to="/settings/general" replace />} />
          <Route path="general" element={<GeneralSettings />} />
          <Route path="llm/*" element={<LlmProfilesSettings />} />
          <Route path="usage" element={<UsageSettings />} />
          <Route path="security" element={<SecuritySettings />} />
          <Route path="backup" element={<BackupSettings />} />
          <Route path="system" element={<SystemStatus />} />
        </Routes>
      </main>
    </div>
  );
}
