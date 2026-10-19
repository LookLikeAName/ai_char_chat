// 有設定密碼又還沒登入時，只顯示登入頁；其他畫面（與 WebSocket）都等登入後才載入。
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qk, UNAUTHORIZED_EVENT } from '../../lib/api.ts';
import { errorText } from '../../lib/toast.tsx';
import { Icon } from '../../components/Icon.tsx';

export function AuthGate({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: qk.auth, queryFn: api.authStatus, staleTime: Infinity });

  // 用到一半 cookie 失效（例如在別的裝置按了「登出所有裝置」）：回到登入頁
  useEffect(() => {
    const onUnauthorized = () => void qc.invalidateQueries({ queryKey: qk.auth });
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [qc]);

  if (isLoading) return null;
  if (error || !data) {
    return (
      <div className="login">
        <div className="login-card">
          <p className="warn-text">連不上伺服器：{errorText(error)}</p>
          <button className="btn" onClick={() => void refetch()}>
            重試
          </button>
        </div>
      </div>
    );
  }
  if (data.enabled && !data.authenticated) return <LoginPage />;
  return <>{children}</>;
}

function LoginPage() {
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api.login(password, remember);
      // 重新載入，讓所有資料與 WebSocket 帶著 cookie 重新開始
      window.location.reload();
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="login-logo" aria-hidden>
          <Icon name="chat" size={26} />
        </div>
        <h1>AI Avatar 聊天</h1>
        <label className="field">
          <span className="field-label">密碼</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            aria-invalid={!!error}
          />
        </label>
        <label className="check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          記住這台裝置（30 天）
        </label>
        {error && (
          <p className="warn-text" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary" disabled={!password || pending}>
          {pending ? '登入中…' : '登入'}
        </button>
        <p className="hint">忘記密碼的話，在伺服器上的 .env 設定 APP_PASSWORD 後重新啟動，就能用那個密碼登入。</p>
      </form>
    </div>
  );
}
