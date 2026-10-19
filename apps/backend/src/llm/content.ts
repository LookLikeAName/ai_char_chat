// 訊息內容的小工具：純文字與「文字＋圖片」兩種形式互轉
import type { ContentPart, LoggedContent, MessageContent } from '@acc/shared';

export function partsOf(c: MessageContent): ContentPart[] {
  return typeof c === 'string' ? [{ type: 'text', text: c }] : c;
}

/** 只取文字（圖片換成標記），給不支援圖片的地方用 */
export function textOf(c: MessageContent): string {
  return typeof c === 'string' ? c : c.map((p) => (p.type === 'text' ? p.text : '[圖片]')).join('\n');
}

export function hasImage(c: MessageContent): boolean {
  return typeof c !== 'string' && c.some((p) => p.type === 'image');
}

/** 兩段內容接起來；都是文字時維持文字 */
export function joinContent(a: MessageContent, b: MessageContent): MessageContent {
  if (typeof a === 'string' && typeof b === 'string') return `${a}\n\n${b}`;
  return [...partsOf(a), { type: 'text', text: '\n\n' }, ...partsOf(b)];
}

/** 監控紀錄裡不存整張圖 */
export function loggedContent(c: MessageContent): LoggedContent {
  if (typeof c === 'string') return c;
  return c.map((p) => (p.type === 'text' ? p : { type: 'image', mime: p.mime, bytes: Math.floor((p.data.length * 3) / 4) }));
}
