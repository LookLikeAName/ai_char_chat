// BullMQ 佇列定義；api 投遞，worker 處理。
export const AGENT_QUEUE = 'agent';

/** 檢查這個對話有沒有還沒回的玩家訊息，有就回覆（重複投遞是安全的） */
export type AgentJob = { kind: 'reply'; conversationId: string };

export interface JobQueue {
  add(job: AgentJob, opts?: { delayMs?: number }): Promise<void>;
}

/** 回覆失敗時的重試：3 次，間隔 3、6 秒 */
export const REPLY_JOB_OPTIONS = { attempts: 3, backoff: { type: 'exponential', delay: 3000 } } as const;
