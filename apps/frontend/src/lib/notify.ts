// 瀏覽器通知：分頁在背景時，avatar 傳來的訊息跳出系統通知。
// 通知權限是每個瀏覽器各自的，所以開關存在這台裝置（localStorage），不存在伺服器設定。
import { useSyncExternalStore } from 'react';

const KEY = 'acc.notifications';
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
}

export const notificationsSupported = typeof window !== 'undefined' && 'Notification' in window;

export function notificationsEnabled(): boolean {
  return notificationsSupported && Notification.permission === 'granted' && read();
}

/** 開啟時會請求權限；使用者拒絕的話回傳 false */
export async function setNotifications(on: boolean): Promise<boolean> {
  if (on) {
    if (!notificationsSupported) return false;
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (permission !== 'granted') return false;
  }
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // 無痕模式等情況存不了，只在這次有效
  }
  for (const l of listeners) l();
  return on;
}

export function useNotificationsEnabled(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    notificationsEnabled,
    () => false,
  );
}

export function showNotification(opts: { title: string; body: string; icon?: string | null; tag: string; onClick: () => void }) {
  if (!notificationsEnabled() || document.visibilityState === 'visible') return;
  try {
    const n = new Notification(opts.title, { body: opts.body, icon: opts.icon ?? undefined, tag: opts.tag });
    n.onclick = () => {
      window.focus();
      opts.onClick();
      n.close();
    };
  } catch {
    // 有些行動瀏覽器只允許透過 service worker 顯示通知，這裡就不顯示
  }
}
