// BullMQ 佇列定義；api 投遞，worker 處理。
export const AGENT_QUEUE = 'agent';

export type AgentJob =
  /** 檢查這個對話有沒有還沒回的玩家訊息，有就回覆（重複投遞是安全的） */
  | { kind: 'reply'; conversationId: string; force?: boolean }
  /** 對話告一段落時整理記憶（重複投遞是安全的） */
  | { kind: 'memory.extract'; avatarId: string; conversationId: string; force?: boolean }
  /** 每小時：替需要的 avatar 整理印象 */
  | { kind: 'maintenance' }
  /** 每 15 分鐘：產生今天的生活日誌、決定要不要主動傳訊息 */
  | { kind: 'proactive.tick' }
  /** 主動傳訊息給玩家 */
  | { kind: 'proactive'; avatarId: string; conversationId: string }
  /** 群組：玩家發話後的一輪（重複投遞是安全的） */
  | { kind: 'group.turn'; conversationId: string; force?: boolean }
  /** 群組：某個 avatar 主動開話題 */
  | { kind: 'group.proactive'; conversationId: string; avatarId: string };

export interface JobQueue {
  add(job: AgentJob, opts?: { delayMs?: number }): Promise<void>;
}

/** 回覆失敗時的重試：3 次，間隔 3、6 秒 */
export const REPLY_JOB_OPTIONS = { attempts: 3, backoff: { type: 'exponential', delay: 3000 } } as const;

/** 記憶萃取失敗（多半是沒設定系統工具模型）不需要一直重試 */
export const MEMORY_JOB_OPTIONS = { attempts: 2, backoff: { type: 'fixed', delay: 60_000 } } as const;
