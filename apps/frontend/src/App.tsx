import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { Rail } from './components/Rail.tsx';
import { api, qk } from './lib/api.ts';
import { AvatarsPage } from './pages/avatars/AvatarsPage.tsx';
import { ChatsPage } from './pages/chats/ChatsPage.tsx';
import { MonitorPage } from './pages/monitor/MonitorPage.tsx';
import { OnboardingPage } from './pages/profile/OnboardingPage.tsx';
import { ProfilePage } from './pages/profile/ProfilePage.tsx';
import { SettingsPage } from './pages/settings/SettingsPage.tsx';

export function App() {
  const location = useLocation();
  const { data: profile } = useQuery({ queryKey: qk.profile, queryFn: api.profile });
  const { data: conversations } = useQuery({ queryKey: qk.conversations, queryFn: api.conversations });
  // 分頁標題顯示未讀數（正在看的對話會馬上變成已讀）
  const unread = conversations?.reduce((n, c) => n + c.unreadCount, 0) ?? 0;
  useEffect(() => {
    document.title = unread ? `(${unread > 99 ? '99+' : unread}) AI Avatar 聊天` : 'AI Avatar 聊天';
  }, [unread]);
  // 第一次使用（還沒填偏好問卷）先到歡迎頁；設定頁不擋，方便先設定 LLM
  const firstRun =
    profile && !profile.preferences && !/^\/(welcome|settings|monitor)/.test(location.pathname);

  return (
    <div className="app">
      <Rail />
      {firstRun && <Navigate to="/welcome" replace />}
      <Routes>
        <Route path="/welcome" element={<OnboardingPage />} />
        <Route path="/" element={<Navigate to="/chats" replace />} />
        <Route path="/chats/:conversationId?" element={<ChatsPage />} />
        <Route path="/avatars/:avatarId?" element={<AvatarsPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/settings/*" element={<SettingsPage />} />
        <Route path="/monitor/*" element={<MonitorPage />} />
        <Route path="*" element={<Navigate to="/chats" replace />} />
      </Routes>
    </div>
  );
}
