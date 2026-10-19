import { Icon } from '../components/Icon.tsx';

export function ProfilePage() {
  return (
    <main className="pane-main full">
      <div className="chat-empty">
        <Icon name="profile" size={40} />
        <p>我的 profile</p>
        <p className="hint">心理測驗（五大人格、依附風格、價值觀）與偏好問卷在第 4 階段加入。</p>
      </div>
    </main>
  );
}
