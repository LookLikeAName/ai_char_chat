// 監控頁的 API：事件、LLM 呼叫紀錄（完整 context）、佇列、手動操作、用量、prompt 預覽、記憶檢索測試。
import type { FastifyInstance } from 'fastify';
import { and, avg, count, desc, eq, gte, ilike, inArray, isNotNull, lt, sql, sum } from 'drizzle-orm';
import { z } from 'zod';
import { EVENT_CATEGORIES, type QueueDto, type TraceDto, type UsageRowDto } from '@acc/shared';
import { avatars, conversationMembers, eventLog, llmTraces, usageLog } from '../db/schema.ts';
import { notFound, parseBody } from '../errors.ts';
import { embedderFromSettings } from '../memory/embedder.ts';
import { retrieveMemories } from '../memory/store.ts';
import { eventToDto, traceSummary } from '../observability.ts';
import { ReplyEngine } from '../reply/engine.ts';
import { loadSettings } from '../services/settings.ts';

const listQuery = z.object({
  before: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  category: z.enum(EVENT_CATEGORIES).optional(),
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  avatarId: z.uuid().optional(),
  conversationId: z.uuid().optional(),
  q: z.string().trim().max(100).optional(),
});

const traceQuery = z.object({
  before: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  purpose: z.string().max(50).optional(),
  avatarId: z.uuid().optional(),
  failed: z.coerce.boolean().optional(),
});

const idParams = z.object({ id: z.uuid() });
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;

/** api 行程裡的佇列操作（測試時可以省略） */
export interface QueueInspector {
  snapshot(): Promise<Omit<QueueDto, 'replyPlans'>>;
  promote(jobId: string): Promise<boolean>;
}

export async function debugRoutes(app: FastifyInstance) {
  const { db, jobs } = app.deps;
  const engine = new ReplyEngine({
    db,
    box: app.deps.box,
    events: app.deps.events,
    // 預覽不需要鎖
    lock: { acquire: async () => 'preview', release: async () => {} },
    fetchFn: app.deps.fetchFn,
    mediaDir: app.deps.mediaDir,
  });

  app.get('/debug/events', async (req) => {
    const q = parseBody(listQuery, req.query);
    const minLevel = q.level ? LEVELS[q.level] : 0;
    const allowed = (Object.keys(LEVELS) as (keyof typeof LEVELS)[]).filter((l) => LEVELS[l] >= minLevel);
    const rows = await db
      .select()
      .from(eventLog)
      .where(
        and(
          q.before ? lt(eventLog.id, q.before) : undefined,
          q.category ? eq(eventLog.category, q.category) : undefined,
          minLevel ? inArray(eventLog.level, allowed) : undefined,
          q.avatarId ? eq(eventLog.avatarId, q.avatarId) : undefined,
          q.conversationId ? eq(eventLog.conversationId, q.conversationId) : undefined,
          q.q ? ilike(eventLog.message, `%${q.q.replace(/[%_]/g, (c) => `\\${c}`)}%`) : undefined,
        ),
      )
      .orderBy(desc(eventLog.id))
      .limit(q.limit);
    return rows.map(eventToDto);
  });

  app.get('/debug/traces', async (req) => {
    const q = parseBody(traceQuery, req.query);
    const rows = await db
      .select()
      .from(llmTraces)
      .where(
        and(
          q.before ? lt(llmTraces.createdAt, new Date(q.before)) : undefined,
          q.purpose ? eq(llmTraces.purpose, q.purpose) : undefined,
          q.avatarId ? eq(llmTraces.avatarId, q.avatarId) : undefined,
          q.failed ? eq(llmTraces.ok, false) : undefined,
        ),
      )
      .orderBy(desc(llmTraces.createdAt))
      .limit(q.limit);
    return rows.map(traceSummary);
  });

  app.get('/debug/traces/:id', async (req): Promise<TraceDto> => {
    const { id } = parseBody(idParams, req.params);
    const [row] = await db.select().from(llmTraces).where(eq(llmTraces.id, id));
    if (!row) throw notFound('這筆 LLM 呼叫紀錄（可能已超過保留天數）');
    return {
      ...traceSummary(row),
      params: row.params,
      request: row.request ?? { messages: [] },
      response: row.response,
      parsed: row.parsed,
    };
  });

  app.get('/debug/queue', async (): Promise<QueueDto> => {
    const snap = (await app.deps.queue?.snapshot()) ?? { counts: {}, delayed: [], active: [], failed: [] };
    const plans = await db
      .select({
        conversationId: conversationMembers.conversationId,
        avatarId: conversationMembers.avatarId,
        avatarName: avatars.name,
        dueAt: conversationMembers.replyDueAt,
        reason: conversationMembers.replyReason,
      })
      .from(conversationMembers)
      .innerJoin(avatars, eq(avatars.id, conversationMembers.avatarId))
      .where(isNotNull(conversationMembers.replyDueAt))
      .orderBy(conversationMembers.replyDueAt);
    return {
      ...snap,
      replyPlans: plans.map((p) => ({ ...p, dueAt: p.dueAt!.toISOString(), reason: p.reason ?? null })),
    };
  });

  app.post('/debug/queue/:jobId/promote', async (req) => {
    const { jobId } = parseBody(z.object({ jobId: z.string().min(1).max(100) }), req.params);
    return { ok: (await app.deps.queue?.promote(jobId)) ?? false };
  });

  /** 不等預計時間，立刻回覆 */
  app.post('/debug/conversations/:id/reply-now', async (req) => {
    const { id } = parseBody(idParams, req.params);
    await jobs.add({ kind: 'reply', conversationId: id, force: true });
    return { ok: true };
  });

  /** 不等對話停下，立刻整理記憶 */
  app.post('/debug/conversations/:id/extract-now', async (req) => {
    const { id } = parseBody(idParams, req.params);
    const members = await db.select().from(conversationMembers).where(eq(conversationMembers.conversationId, id));
    for (const m of members) {
      await jobs.add({ kind: 'memory.extract', avatarId: m.avatarId, conversationId: id, force: true });
    }
    return { ok: true, avatars: members.length };
  });

  app.post('/debug/run/:task', async (req) => {
    const { task } = parseBody(z.object({ task: z.enum(['proactive-tick', 'maintenance']) }), req.params);
    await jobs.add(task === 'proactive-tick' ? { kind: 'proactive.tick' } : { kind: 'maintenance' });
    return { ok: true };
  });

  /** 某段時間內各用途、各模型的用量 */
  app.get('/debug/usage', async (req): Promise<UsageRowDto[]> => {
    const { hours } = parseBody(z.object({ hours: z.coerce.number().int().min(1).max(24 * 90).default(24) }), req.query);
    const since = new Date(Date.now() - hours * 3_600_000);
    const rows = await db
      .select({
        purpose: usageLog.purpose,
        model: usageLog.model,
        calls: count(),
        failed: sql<number>`count(*) filter (where not ${usageLog.ok})`,
        inputTokens: sum(usageLog.inputTokens),
        outputTokens: sum(usageLog.outputTokens),
        avgLatencyMs: avg(usageLog.latencyMs),
      })
      .from(usageLog)
      .where(gte(usageLog.createdAt, since))
      .groupBy(usageLog.purpose, usageLog.model)
      .orderBy(desc(count()));
    return rows.map((r) => ({
      purpose: r.purpose,
      model: r.model,
      calls: Number(r.calls),
      failed: Number(r.failed),
      inputTokens: Number(r.inputTokens ?? 0),
      outputTokens: Number(r.outputTokens ?? 0),
      avgLatencyMs: Math.round(Number(r.avgLatencyMs ?? 0)),
    }));
  });

  /** 如果現在回覆（或主動發話），會送出什麼 prompt；不會呼叫 LLM */
  app.get('/debug/preview/:id', async (req) => {
    const { id } = parseBody(idParams, req.params);
    const { mode, avatarId } = parseBody(
      z.object({ mode: z.enum(['reply', 'proactive']).default('reply'), avatarId: z.uuid().optional() }),
      req.query,
    );
    const preview = await engine.previewPrompt(id, mode, avatarId);
    if (!preview) throw notFound('對話（群組請指定成員）');
    return preview;
  });

  /** 記憶檢索測試：這段話會讓 avatar 想起哪些記憶，以及分數組成 */
  app.post('/debug/avatars/:id/retrieve', async (req) => {
    const { id } = parseBody(idParams, req.params);
    const { query, limit } = parseBody(
      z.object({ query: z.string().trim().max(1000), limit: z.number().int().min(1).max(50).default(15) }),
      req.body,
    );
    const settings = await loadSettings(db);
    const embedder = await embedderFromSettings(db, app.deps.box, settings, app.deps.fetchFn).catch(() => null);
    const rows = await retrieveMemories(db, embedder, { avatarId: id, query, limit, touch: false });
    return {
      embedder: embedder?.model ?? null,
      rows: rows.map((m) => ({
        id: m.id,
        content: m.content,
        importance: m.importance,
        createdAt: m.createdAt.toISOString(),
        relevance: Math.round(m.relevance * 1000) / 1000,
        recency: Math.round(m.recency * 1000) / 1000,
        score: Math.round(m.score * 1000) / 1000,
      })),
    };
  });
}
