const timeFmt = new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
const dateFmt = new Intl.DateTimeFormat('zh-TW', { month: 'numeric', day: 'numeric' });
const fullDateFmt = new Intl.DateTimeFormat('zh-TW', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** 聊天列表用：今天顯示時間，其他顯示日期 */
export function shortTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return sameDay(d, new Date()) ? timeFmt.format(d) : dateFmt.format(d);
}

export function clockTime(iso: string): string {
  return timeFmt.format(new Date(iso));
}

export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (sameDay(d, today)) return '今天';
  if (sameDay(d, yesterday)) return '昨天';
  return fullDateFmt.format(d);
}
