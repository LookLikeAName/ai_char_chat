import { useQuery } from '@tanstack/react-query';
import { api, qk } from '../../lib/api.ts';

const timeFmt = new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dateTimeFmt = new Intl.DateTimeFormat('zh-TW', {
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function clock(iso: string): string {
  const d = new Date(iso);
  return new Date().toDateString() === d.toDateString() ? timeFmt.format(d) : dateTimeFmt.format(d);
}

/** 還有多久（或已經過了多久） */
export function relative(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  const abs = Math.abs(ms);
  const text =
    abs < 60_000 ? `${Math.round(abs / 1000)} 秒` : abs < 3_600_000 ? `${Math.round(abs / 60_000)} 分鐘` : `${(abs / 3_600_000).toFixed(1)} 小時`;
  return ms >= 0 ? `${text}後` : `${text}前`;
}

/** avatar 與對話的名字 */
export function useNames() {
  const { data: avatars = [] } = useQuery({ queryKey: qk.avatars, queryFn: api.avatars });
  const { data: conversations = [] } = useQuery({ queryKey: qk.conversations, queryFn: api.conversations });
  const avatarName = (id: string | null) => (id ? (avatars.find((a) => a.id === id)?.name ?? id.slice(0, 8)) : '');
  const conversationName = (id: string | null) =>
    id ? (conversations.find((c) => c.id === id)?.title ?? id.slice(0, 8)) : '';
  return { avatars, conversations, avatarName, conversationName };
}

export { USAGE_PURPOSE_LABELS as PURPOSE_LABELS } from '@acc/shared';
