// 登入密碼：設定、修改、移除；登出、登出所有裝置
import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PASSWORD_MIN } from '@acc/shared';
import { api, qk } from '../../lib/api.ts';
import { errorText, useToast } from '../../lib/toast.tsx';

export function SecuritySettings() {
  const toast = useToast();
  const { data: status, refetch } = useQuery({ queryKey: qk.auth, queryFn: api.authStatus });
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm2, setConfirm2] = useState('');
  const [pending, setPending] = useState(false);
  if (!status) return <p className="hint pad">載入中…</p>;
  const lanHint = location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';

  const change = async (e: FormEvent, value: string | null) => {
    e.preventDefault();
    setPending(true);
    try {
      await api.setPassword(status.enabled ? current : undefined, value);
      toast(value ? '密碼已更新，其他裝置要重新登入' : '已移除密碼', 'success');
      setCurrent('');
      setNext('');
      setConfirm2('');
      await refetch();
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setPending(false);
    }
  };

  const mismatch = !!confirm2 && next !== confirm2;
  const canSave = next.length >= PASSWORD_MIN && next === confirm2 && (!status.enabled || !!current) && !pending;

  return (
    <div className="editor">
      <header className="editor-head">
        <h1>安全性</h1>
      </header>

      <section className="card">
        <h2>登入密碼</h2>
        <p className="hint">
          {status.enabled
            ? '已設定密碼：打開網頁要先登入，聊天內容、頭像與照片也都要登入後才看得到。'
            : '目前沒有密碼，任何打得開這個網址的人都能使用。只在自己的電腦上用沒關係；要開放給區網（WEB_BIND=0.0.0.0）時請設定密碼。'}
        </p>
        {!status.enabled && lanHint && <p className="warn-text">你現在是從其他裝置連線，建議馬上設定密碼。</p>}
        {status.managedByEnv ? (
          <p className="hint">密碼由伺服器的環境變數 APP_PASSWORD 設定；要修改請改 .env 後重新啟動。</p>
        ) : (
          <form className="password-form" onSubmit={(e) => void change(e, next)}>
            {/* 讓密碼管理工具知道是哪個帳號 */}
            <input type="text" name="username" autoComplete="username" value="ai-char-chat" readOnly hidden />
            {status.enabled && (
              <label className="field">
                <span className="field-label">目前的密碼</span>
                <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
              </label>
            )}
            <label className="field">
              <span className="field-label">{status.enabled ? '新密碼' : '密碼'}（至少 {PASSWORD_MIN} 個字）</span>
              <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
            </label>
            <label className="field">
              <span className="field-label">再輸入一次</span>
              <input
                type="password"
                autoComplete="new-password"
                value={confirm2}
                onChange={(e) => setConfirm2(e.target.value)}
                aria-invalid={mismatch}
              />
              {mismatch && <span className="warn-text">兩次輸入的不一樣</span>}
            </label>
            <div className="row">
              <button type="submit" className="btn btn-primary" disabled={!canSave}>
                {status.enabled ? '更新密碼' : '設定密碼'}
              </button>
              {status.enabled && (
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={!current || pending}
                  onClick={(e) => {
                    if (confirm('移除密碼之後，任何打得開這個網址的人都能使用。確定嗎？')) void change(e, null);
                  }}
                >
                  移除密碼
                </button>
              )}
            </div>
          </form>
        )}
      </section>

      {status.enabled && (
        <section className="card">
          <h2>登入的裝置</h2>
          <div className="row">
            <button
              className="btn"
              onClick={async () => {
                await api.logout();
                window.location.reload();
              }}
            >
              登出這台裝置
            </button>
            <button
              className="btn btn-ghost"
              onClick={async () => {
                try {
                  await api.logoutAll();
                  toast('其他裝置都要重新登入了', 'success');
                } catch (err) {
                  toast(errorText(err), 'error');
                }
              }}
            >
              登出所有其他裝置
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
