// 監控：事件 log 與 LLM 呼叫紀錄。
//
// 用 AsyncLocalStorage 帶著「目前在處理哪個 avatar、哪個對話」，
// 所以各模組只要呼叫 logEvent()，不用一路傳參數。寫入失敗不影響主流程。
import { AsyncLocalStorage } from 'node:async_hooks';
import { eq, lt } from 'drizzle-orm';
import type { DebugEventDto, EventCategory, EventLevel, ServerEvent, TraceDto, TraceSummaryDto } from '@acc/shared';
import type { Db } from './db/client.ts';
import { eventLog, llmTraces } from './db/schema.ts';

export interface TraceScope {
  avatarId?: string | null;
  conversationId?: string | null;
}

const scope = new AsyncLocalStorage<TraceScope>();

/** 在這個範圍內產生的事件與 LLM 呼叫，都會標上 avatar 與對話 */
export function withScope<T>(s: TraceScope, fn: () => Promise<T>): Promise<T> {
  return scope.run({ ...scope.getStore(), ...s }, fn);
}

export function currentScope(): TraceScope {
  return scope.getStore() ?? {};
}

interface Sink {
  db: Db;
  publish: (e: ServerEvent) => Promise<void>;
  /** 是否記錄完整 context（設定頁可以關閉） */
  captureContext: () => Promise<boolean>;
  /** 同時印在 console（worker 的 docker logs 也看得到） */
  console?: boolean;
}

let sink: Sink | null = null;

export function configureObservability(s: Sink | null): void {
  sink = s;
}

export interface EventInput {
  category: EventCategory;
  type: string;
  message: string;
  level?: EventLevel;
  avatarId?: string | null;
  conversationId?: string | null;
  traceId?: string | null;
  data?: Record<string, unknown>;
}

export async function logEvent(e: EventInput): Promise<void> {
  const s = sink;
  if (!s) return;
  const sc = currentScope();
  const level = e.level ?? 'info';
  if (s.console && level !== 'debug') console.log(`[${e.category}] ${e.message}`);
  try {
    const [row] = await s.db
      .insert(eventLog)
      .values({
        level,
        category: e.category,
        type: e.type,
        message: e.message.slice(0, 500),
        avatarId: e.avatarId ?? sc.avatarId ?? null,
        conversationId: e.conversationId ?? sc.conversationId ?? null,
        traceId: e.traceId ?? null,
        data: e.data ?? {},
      })
      .returning();
    await s.publish({ type: 'debug.event', event: eventToDto(row!) });
  } catch {
    // 監控不能影響主流程
  }
}

export function eventToDto(r: typeof eventLog.$inferSelect): DebugEventDto {
  return {
    id: r.id,
    at: r.at.toISOString(),
    level: r.level,
    category: r.category,
    type: r.type,
    message: r.message,
    avatarId: r.avatarId,
    conversationId: r.conversationId,
    traceId: r.traceId,
    data: r.data,
  };
}

export interface TraceInput {
  purpose: string;
  provider: string;
  model: string;
  params: Record<string, unknown>;
  request: TraceDto['request'];
  response: string | null;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  ok: boolean;
  error: string | null;
  avatarId?: string | null;
}

/** 記錄一次 LLM 呼叫；回傳 trace id（沒有設定監控時為 null） */
export async function recordTrace(t: TraceInput): Promise<string | null> {
  const s = sink;
  if (!s) return null;
  const sc = currentScope();
  try {
    const capture = await s.captureContext();
    const [row] = await s.db
      .insert(llmTraces)
      .values({
        purpose: t.purpose,
        avatarId: t.avatarId ?? sc.avatarId ?? null,
        conversationId: sc.conversationId ?? null,
        provider: t.provider,
        model: t.model,
        params: t.params,
        request: capture ? t.request : null,
        response: capture ? t.response : null,
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        latencyMs: t.latencyMs,
        ok: t.ok,
        error: t.error,
      })
      .returning();
    await s.publish({ type: 'debug.trace', trace: traceSummary(row!) });
    return row!.id;
  } catch {
    return null;
  }
}

/** 呼叫端解析完輸出後補上（例如回覆的 JSON） */
export async function attachParsed(traceId: string | null | undefined, parsed: unknown): Promise<void> {
  if (!sink || !traceId) return;
  await sink.db
    .update(llmTraces)
    .set({ parsed: parsed as never })
    .where(eq(llmTraces.id, traceId))
    .catch(() => {});
}

export function traceSummary(r: typeof llmTraces.$inferSelect): TraceSummaryDto {
  return {
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    purpose: r.purpose,
    avatarId: r.avatarId,
    conversationId: r.conversationId,
    provider: r.provider,
    model: r.model,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    latencyMs: r.latencyMs,
    ok: r.ok,
    error: r.error,
  };
}

/** 刪除超過保留天數的事件與紀錄 */
export async function pruneObservability(db: Db, retentionDays: number, now = new Date()): Promise<void> {
  const before = new Date(now.getTime() - retentionDays * 86_400_000);
  await db.delete(eventLog).where(lt(eventLog.at, before));
  await db.delete(llmTraces).where(lt(llmTraces.createdAt, before));
}
