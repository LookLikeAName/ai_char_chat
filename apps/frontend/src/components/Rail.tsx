import { NavLink } from 'react-router';
import { useWsStatus } from '../lib/serverEvents.tsx';
import { Icon, type IconName } from './Icon.tsx';

const ITEMS: { to: string; icon: IconName; label: string }[] = [
  { to: '/chats', icon: 'chat', label: '聊天' },
  { to: '/avatars', icon: 'avatar', label: 'Avatar' },
  { to: '/profile', icon: 'profile', label: '我的 profile' },
];

export function Rail() {
  const ws = useWsStatus();
  return (
    <nav className="rail" aria-label="主選單">
      <div className="rail-logo" aria-hidden>
        <Icon name="chat" size={18} />
      </div>
      {ITEMS.map((it) => (
        <NavLink key={it.to} to={it.to} className="rail-btn" title={it.label} aria-label={it.label}>
          <Icon name={it.icon} size={22} />
        </NavLink>
      ))}
      <div className="rail-spacer" />
      <span
        className={`ws-dot ws-${ws}`}
        title={ws === 'open' ? '已連線' : ws === 'connecting' ? '連線中…' : '已斷線，重新連線中'}
        aria-label={`伺服器連線：${ws === 'open' ? '已連線' : '未連線'}`}
      />
      <NavLink to="/settings" className="rail-btn" title="設定" aria-label="設定">
        <Icon name="settings" size={22} />
      </NavLink>
    </nav>
  );
}
