// 失敗的 LLM 呼叫：還沒有後續成功的話，可以從監控頁重新觸發那件事（不是重送同一個請求，而是重跑那個工作，結果才會套用）。
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { MANUAL_RETRY_HINTS, RETRYABLE_PURPOSES, type TraceRetry, type TraceRetryResultDto } from '@acc/shared';
import type { AppDeps } from '../app.ts';
import { avatars, conversationMembers, conversations, llmTraces, messages } from '../db/schema.ts';
import { HttpError } from '../errors.ts';
import { ensureLifeLog } from '../life/lifeLog.ts';
import { embedderFromSettings } from '../memory/embedder.ts';
import { reflect } from '../memory/reflect.ts';
import { generateSummary } from '../profile/service.ts';
import { loadSettings } from './settings.ts';

type TraceRow = typeof llmTraces.$inferSelect;

/** 之後有沒有同一件事（同用途、avatar、對話）成功的呼叫 */
async function superseded(db: AppDeps['db'], row: TraceRow): Promise<boolean> {
  const [later] = await db
    .select({ id: llmTraces.id })
    .from(llmTraces)
    .where(
      and(
        eq(llmTraces.purpose, row.purpose),
        row.avatarId ? eq(llmTraces.avatarId, row.avatarId) : isNull(llmTraces.avatarId),
        row.conversationId ? eq(llmTraces.conversationId, row.conversationId) : isNull(llmTraces.conversationId),
        eq(llmTraces.ok, true),
        gt(llmTraces.createdAt, row.createdAt),
      ),
    )
    .limit(1);
  return !!later;
}

export async function retryStatus(db: AppDeps['db'], row: TraceRow): Promise<TraceRetry | undefined> {
  if (row.ok) return undefined;
  if (!(row.purpose in RETRYABLE_PURPOSES)) return 'manual';
  return (await superseded(db, row)) ? 'superseded' : 'available';
}

/** 重新觸發這筆失敗的呼叫對應的工作 */
export async function retryTrace(deps: AppDeps, row: TraceRow): Promise<TraceRetryResultDto> {
  const { db, jobs } = deps;
  if (row.ok) throw new HttpError(400, '這筆呼叫是成功的');
  if (!(row.purpose in RETRYABLE_PURPOSES)) {
    throw new HttpError(400, `這種呼叫不能從這裡重新觸發：${MANUAL_RETRY_HINTS[row.purpose] ?? '請在原本的畫面重新操作'}`);
  }
  if (await superseded(db, row)) throw new HttpError(409, '之後已經有成功的呼叫了，不需要重來');
  const settings = await loadSettings(db);

  switch (row.purpose) {
    case 'reply': {
      if (!row.conversationId) throw new HttpError(400, '這筆紀錄沒有對話，無法重新回覆');
      const [conv] = await db.select().from(conversations).where(eq(conversations.id, row.conversationId));
      if (!conv) throw new HttpError(404, '對話已經不存在');
      const [latestUser] = await db
        .select({ at: messages.createdAt })
        .from(messages)
        .where(and(eq(messages.conversationId, conv.id), eq(messages.senderType, 'user')))
        .orderBy(desc(messages.createdAt))
        .limit(1);
      if (conv.type === 'group') {
        if (latestUser && (!conv.handledUpTo || latestUser.at > conv.handledUpTo)) {
          await jobs.add({ kind: 'group.turn', conversationId: conv.id, force: true });
          return { message: '已排入：群組重新回覆這一輪', queued: true };
        }
        if (!row.avatarId) throw new HttpError(400, '這筆紀錄沒有 avatar');
        await jobs.add({ kind: 'group.proactive', conversationId: conv.id, avatarId: row.avatarId });
        return { message: '已排入：在群組重新開話題', queued: true };
      }
      const [member] = await db.select().from(conversationMembers).where(eq(conversationMembers.conversationId, conv.id));
      if (latestUser && (!member?.handledUpTo || latestUser.at > member.handledUpTo)) {
        await jobs.add({ kind: 'reply', conversationId: conv.id, force: true });
        return { message: '已排入：重新回覆', queued: true };
      }
      if (!member) throw new HttpError(404, '對話已經不存在');
      await jobs.add({ kind: 'proactive', conversationId: conv.id, avatarId: member.avatarId });
      return { message: '已排入：重新主動傳訊息', queued: true };
    }
    case 'memory.extract': {
      if (!row.avatarId || !row.conversationId) throw new HttpError(400, '這筆紀錄沒有 avatar 或對話');
      await jobs.add({ kind: 'memory.extract', avatarId: row.avatarId, conversationId: row.conversationId, force: true });
      return { message: '已排入：重新整理記憶', queued: true };
    }
    case 'memory.reflect': {
      if (!row.avatarId) throw new HttpError(400, '這筆紀錄沒有 avatar');
      const embedder = await embedderFromSettings(db, deps.box, settings, deps.fetchFn).catch(() => null);
      const updated = await reflect(deps, settings, embedder, row.avatarId, { force: true });
      if (updated) await deps.events.publish({ type: 'avatar.state.changed', avatarId: row.avatarId });
      return { message: updated ? '已重新整理印象' : '沒有新的記憶可以整理', queued: false };
    }
    case 'life.log': {
      if (!row.avatarId) throw new HttpError(400, '這筆紀錄沒有 avatar');
      const [avatar] = await db.select().from(avatars).where(eq(avatars.id, row.avatarId));
      if (!avatar) throw new HttpError(404, 'avatar 已經不存在');
      const log = await ensureLifeLog(deps, settings, avatar, new Date());
      return { message: log ? `已產生今天的生活日誌（${log.length} 件事）` : '沒有產生生活日誌（沒有系統工具模型？）', queued: false };
    }
    case 'profile.summary': {
      await generateSummary(deps, settings);
      return { message: '已重新產生 profile 摘要', queued: false };
    }
  }
  throw new HttpError(400, '不支援的用途');
}
