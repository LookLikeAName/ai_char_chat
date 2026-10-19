import { useQuery } from '@tanstack/react-query';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { Rail } from './components/Rail.tsx';
import { api, qk } from './lib/api.ts';
import { AvatarsPage } from './pages/avatars/AvatarsPage.tsx';
import { ChatsPage } from './pages/chats/ChatsPage.tsx';
import { OnboardingPage } from './pages/profile/OnboardingPage.tsx';
import { ProfilePage } from './pages/profile/ProfilePage.tsx';
import { SettingsPage } from './pages/settings/SettingsPage.tsx';

export function App() {
  const location = useLocation();
  const { data: profile } = useQuery({ queryKey: qk.profile, queryFn: api.profile });
  // 第一次使用（還沒填偏好問卷）先到歡迎頁；設定頁不擋，方便先設定 LLM
  const firstRun =
    profile && !profile.preferences && !/^\/(welcome|settings)/.test(location.pathname);

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
        <Route path="*" element={<Navigate to="/chats" replace />} />
      </Routes>
    </div>
  );
}
