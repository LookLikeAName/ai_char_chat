import { Navigate, Route, Routes } from 'react-router';
import { Rail } from './components/Rail.tsx';
import { AvatarsPage } from './pages/avatars/AvatarsPage.tsx';
import { ChatsPage } from './pages/chats/ChatsPage.tsx';
import { ProfilePage } from './pages/ProfilePage.tsx';
import { SettingsPage } from './pages/settings/SettingsPage.tsx';

export function App() {
  return (
    <div className="app">
      <Rail />
      <Routes>
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
