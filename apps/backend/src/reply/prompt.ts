// 組出一對一回覆的 prompt。順序：角色設定（固定，利於快取）→ 規則 → 現在的情境 → 對話紀錄。
import type { AppSettings } from '@acc/shared';
import type { ChatMessage } from '../llm/index.ts';

export interface PromptAvatar {
  name: string;
  bio: string;
  persona: Record<string, unknown>;
}

export interface HistoryMessage {
  senderType: 'user' | 'avatar';
  content: string;
  createdAt: Date;
}

export interface ReplyPromptInput {
  avatar: PromptAvatar;
  settings: Pick<AppSettings, 'timezone' | 'adultContent'>;
  /** 由舊到新 */
  history: HistoryMessage[];
  now: Date;
}

/** 對話紀錄的字數上限（大約 8k tokens），超過就從最舊的開始捨棄 */
const HISTORY_CHAR_BUDGET = 16_000;
const HISTORY_MAX_MESSAGES = 80;
/** 兩則訊息相隔超過這個時間，就在紀錄裡標註過了多久 */
const GAP_NOTE_MS = 60 * 60 * 1000;

export function formatNow(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: timezone,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
}

export function formatGap(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} 分鐘`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} 小時`;
  return `${Math.round(hours / 24)} 天`;
}

function personaSection(persona: Record<string, unknown>): string {
  // 第 3 階段的 avatar creator 會定義完整欄位；在那之前有什麼就照實列出
  const entries = Object.entries(persona).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!entries.length) return '';
  return entries.map(([k, v]) => `- ${k}：${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n');
}

export function buildSystemPrompt(input: ReplyPromptInput): string {
  const { avatar, settings, now, history } = input;
  const persona = personaSection(avatar.persona);
  // 玩家最新這串訊息之前的最後一則（通常是 avatar 上次說的話）
  let i = history.length - 1;
  while (i >= 0 && history[i]!.senderType === 'user') i--;
  const before = history[i];
  const sinceLast = before ? now.getTime() - before.createdAt.getTime() : null;

  const content = settings.adultContent
    ? '允許成人內容。你和對方都是成年人；是否發展到親密或露骨的內容，取決於你的個性、你們的關係和當下的氣氛，你可以拒絕。'
    : '不寫露骨的性內容。對方往這個方向帶時，用符合你個性的方式婉拒、害羞帶過或轉移話題。';

  return `你是「${avatar.name}」，正在用手機通訊軟體和對方聊天。你是一個真實的人，有自己的生活、想法和情緒，不是 AI 助理。

# 你的設定
${avatar.bio || '（沒有額外描述）'}
${persona ? `\n${persona}\n` : ''}
# 你和對方
你們的關係還沒有特別設定：就當作透過朋友認識不久、正在慢慢熟悉的人。

# 規則
- 完全以「${avatar.name}」的身分說話，言行符合你的設定；絕對不要說自己是 AI、模型、程式或角色扮演。
- 像真人傳訊息：口語、自然、通常很短。一次可以傳 1～4 則，一則一個想法；不要用 Markdown、條列或標題。
- 你有自己的立場：可以不同意、吐槽、開玩笑、拒絕、轉移話題，也可以主動問對方問題；不需要討好對方。
- 不要捏造對方沒說過的事；不知道就問。
- 除非你的設定另有指定，用繁體中文（台灣用語）。
- ${content}

# 現在
現在時間：${formatNow(now, settings.timezone)}${sinceLast !== null && sinceLast > GAP_NOTE_MS ? `\n距離上一則訊息過了 ${formatGap(sinceLast)}。` : ''}

# 輸出格式
只輸出一個 JSON 物件，不要有其他文字：
{"inner_thought": "你此刻心裡的想法（對方看不到，一兩句）", "messages": ["第一則訊息", "第二則訊息"]}`;
}

/**
 * 對話紀錄轉成 user / assistant 交替的訊息。
 * avatar 的連續訊息合成一個 assistant 回合，並寫成和輸出相同的 JSON，讓模型維持格式。
 */
export function buildHistory(history: HistoryMessage[]): ChatMessage[] {
  const recent = history.slice(-HISTORY_MAX_MESSAGES);
  // 從最新往回累計字數
  let budget = HISTORY_CHAR_BUDGET;
  let start = recent.length;
  while (start > 0 && budget - recent[start - 1]!.content.length >= 0) {
    budget -= recent[start - 1]!.content.length;
    start--;
  }
  const kept = recent.slice(start);

  const turns: { role: 'user' | 'assistant'; parts: string[] }[] = [];
  kept.forEach((m, i) => {
    const prev = kept[i - 1];
    const gap = prev ? m.createdAt.getTime() - prev.createdAt.getTime() : 0;
    const role = m.senderType === 'user' ? 'user' : 'assistant';
    let text = m.content;
    if (gap > GAP_NOTE_MS && role === 'user') text = `（${formatGap(gap)}後）${text}`;
    const last = turns.at(-1);
    if (last && last.role === role) last.parts.push(text);
    else turns.push({ role, parts: [text] });
  });

  return turns.map((t) => ({
    role: t.role,
    content: t.role === 'user' ? t.parts.join('\n') : JSON.stringify({ messages: t.parts }),
  }));
}

export function buildReplyPrompt(input: ReplyPromptInput): { system: string; messages: ChatMessage[] } {
  return { system: buildSystemPrompt(input), messages: buildHistory(input.history) };
}
