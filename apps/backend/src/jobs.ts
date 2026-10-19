// BullMQ 佇列定義；api 投遞，worker 處理。
export const AGENT_QUEUE = 'agent';

export type AgentJob = { kind: 'user-message'; conversationId: string; messageId: string };

export interface JobQueue {
  add(job: AgentJob, opts?: { delayMs?: number; jobId?: string }): Promise<void>;
}
