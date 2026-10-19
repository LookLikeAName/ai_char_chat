// 除錯與監控：事件 log 與 LLM 呼叫紀錄（含完整 context）的資料格式。

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
}

export interface TraceDto extends TraceSummaryDto {
  params: Record<string, unknown>;
  request: { system?: string; messages: { role: string; content: string }[]; json?: boolean };
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
  messages: { role: string; content: string }[];
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
