// 除錯與監控：事件 log 與 LLM 呼叫紀錄（含完整 context）的資料格式。
import type { LoggedContent } from './llm.ts';

export const EVENT_CATEGORIES = ['reply', 'state', 'memory', 'proactive', 'life', 'group', 'llm', 'usage', 'job', 'system'] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];
export type EventLevel = 'debug' | 'info' | 'warn' | 'error';

export const CATEGORY_LABELS: Record<EventCategory, string> = {
  reply: '回覆',
  state: '心情與關係',
  memory: '記憶',
  proactive: '主動發話',
  life: '生活日誌',
  group: '群組',
  llm: 'LLM',
  usage: '用量',
  job: '工作佇列',
  system: '系統',
};

export interface DebugEventDto {
  id: number;
  at: string;
  level: EventLevel;
  category: EventCategory;
  /** 機器可讀的類型，例如 reply.scheduled */
  type: string;
  /** 給人看的一句話 */
  message: string;
  avatarId: string | null;
  conversationId: string | null;
  /** 對應的 LLM 呼叫 */
  traceId: string | null;
  data: Record<string, unknown>;
}

export interface TraceSummaryDto {
  id: string;
  createdAt: string;
  purpose: string;
  avatarId: string | null;
  conversationId: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  ok: boolean;
  error: string | null;
  /** 失敗的呼叫能不能從監控頁重新觸發（成功的為 undefined） */
  retry?: TraceRetry;
}

/**
 * available：可以重新呼叫；superseded：之後已經有同一件事（同用途、avatar、對話）成功的呼叫；
 * manual：這種呼叫要在原本的畫面重新操作（例如補完角色），或下次會自動重試（描述圖片）
 */
export type TraceRetry = 'available' | 'superseded' | 'manual';

/** 可以從監控頁重新觸發的用途，與重新觸發時做的事 */
export const RETRYABLE_PURPOSES: Record<string, string> = {
  reply: '重新回覆（沒有還沒回的訊息時，重新主動發話）',
  'memory.extract': '重新整理這段對話的記憶',
  'memory.reflect': '重新整理對你的印象',
  'life.log': '重新產生今天的生活日誌',
  'profile.summary': '重新產生你的 profile 摘要',
};

/** 不能從這裡重新觸發的用途：該去哪裡操作 */
export const MANUAL_RETRY_HINTS: Record<string, string> = {
  'persona.generate': '到 avatar 的「人格設定」重新產生',
  'persona.check': '到 avatar 的「人格設定」重新檢查',
  'adult.test': '到「設定 → 一般 → 內容」重新測試',
  'image.caption': '下次回覆時會自動再描述一次',
};

export interface TraceRetryResultDto {
  /** 做了什麼（給玩家看的一句話） */
  message: string;
  /** 排進佇列（之後才會跑）或已經跑完 */
  queued: boolean;
}

export interface TraceDto extends TraceSummaryDto {
  params: Record<string, unknown>;
  request: { system?: string; messages: { role: string; content: LoggedContent }[]; json?: boolean };
  response: string | null;
  /** 呼叫端解析後的結果（例如回覆的 JSON） */
  parsed: unknown;
}

export interface QueueJobDto {
  id: string;
  kind: string;
  data: Record<string, unknown>;
  /** delayed：預計執行時間；其他狀態：建立時間 */
  at: string;
  attempts: number;
  failedReason: string | null;
}

export interface QueueDto {
  counts: Record<string, number>;
  delayed: QueueJobDto[];
  active: QueueJobDto[];
  failed: QueueJobDto[];
  /** 每個對話「預計什麼時候看到」 */
  replyPlans: { conversationId: string; avatarId: string; avatarName: string; dueAt: string; reason: string | null }[];
}

export interface UsageRowDto {
  purpose: string;
  model: string;
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  avgLatencyMs: number;
}

export interface PromptPreviewDto {
  system: string;
  messages: { role: string; content: LoggedContent }[];
  /** 預覽時的條件（情境、關係、取回的記憶數…） */
  notes: Record<string, unknown>;
}

export interface RetrievalRowDto {
  id: string;
  content: string;
  importance: number;
  createdAt: string;
  relevance: number;
  recency: number;
  score: number;
}
