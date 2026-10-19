// 每 15 分鐘：替每個 avatar 準備今天的生活日誌，並依機率決定要不要主動傳訊息給玩家。
import { and, desc, eq, inArray } from 'drizzle-orm';
import { availabilityAt, inTimeRange, localClock, proactiveChance, type AppSettings } from '@acc/shared';
import type { Db } from '../db/client.ts';
import { avatars, avatarState, conversationMembers, conversations, messages } from '../db/schema.ts';
import type { AgentJob } from '../jobs.ts';
import { ensureLifeLog } from '../life/lifeLog.ts';
import { getRelationship } from '../relationship/service.ts';
import type { CallContext } from '../services/llmCall.ts';

/** 焦慮型依附的角色，上一則主動訊息沒被回、而且過了這麼久，會再追一則 */
const ANXIOUS_FOLLOW_UP_MS = 3 * 60 * 60 * 1000;
/** 決定要傳之後，在接下來的 10 分鐘內隨機一個時間點，不會剛好卡在整點 */
const SPREAD_MS = 10 * 60 * 1000;

export type TickDecision = { avatarId: string; action: 'enqueued' | 'skipped'; reason: string; chance?: number };

export async function proactiveTick(
  ctx: CallContext,
  settings: AppSettings,
  enqueue: (job: AgentJob, delayMs: number) => Promise<void>,
  opts: { now?: Date; random?: () => number } = {},
): Promise<TickDecision[]> {
  const db: Db = ctx.db;
  const now = opts.now ?? new Date();
  const random = opts.random ?? Math.random;
  const clock = localClock(now, settings.timezone);
  const rows = await db
    .select({ avatar: avatars, conversationId: conversations.id })
    .from(avatars)
    .innerJoin(conversationMembers, eq(conversationMembers.avatarId, avatars.id))
    .innerJoin(conversations, and(eq(conversations.id, conversationMembers.conversationId), eq(conversations.type, 'dm')));
  const states = rows.length
    ? await db.select().from(avatarState).where(inArray(avatarState.avatarId, rows.map((r) => r.avatar.id)))
    : [];

  const decisions: TickDecision[] = [];
  for (const { avatar, conversationId } of rows) {
    const skip = (reason: string, chance?: number) => decisions.push({ avatarId: avatar.id, action: 'skipped', reason, chance });
    try {
      await ensureLifeLog(ctx, settings, avatar, now);
    } catch (err) {
      console.error(`[proactive] ${avatar.name} 的生活日誌產生失敗：`, (err as Error).message);
    }
    if (!avatar.llm) {
      skip('沒有大腦');
      continue;
    }
    if (!settings.proactive.enabled) {
      skip('已關閉主動訊息');
      continue;
    }
    if (settings.quietHours.enabled && inTimeRange(clock.hhmm, settings.quietHours.start, settings.quietHours.end)) {
      skip('勿擾時段');
      continue;
    }
    const state = states.find((s) => s.avatarId === avatar.id);
    const todayCount = state?.proactiveDate === clock.date ? state.proactiveCount : 0;
    if (todayCount >= settings.proactive.dailyLimit) {
      skip('今天的次數用完了');
      continue;
    }

    const recent = await db
      .select({ senderType: messages.senderType, meta: messages.meta, createdAt: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), inArray(messages.senderType, ['user', 'avatar'])))
      .orderBy(desc(messages.createdAt), desc(messages.seq))
      .limit(3);
    const last = recent[0];
    if (last?.senderType === 'user') {
      skip('玩家的訊息還沒回');
      continue;
    }
    if (last?.meta.proactive) {
      // 上一則主動訊息還沒被回：一般不追；焦慮型久了會再追一則（但不會連追兩則）
      const anxious = avatar.persona.personality?.attachment === 'anxious';
      const secondInRow = recent[1]?.senderType === 'avatar' && recent[1].meta.proactive;
      if (!anxious || secondInRow || now.getTime() - last.createdAt.getTime() < ANXIOUS_FOLLOW_UP_MS) {
        skip('上一則主動訊息還沒被回');
        continue;
      }
    }

    const rel = await getRelationship(db, avatar.id);
    const chance = proactiveChance({
      availability: availabilityAt(avatar.persona, now, settings.timezone),
      stage: rel.stage,
      extraversion: avatar.persona.personality?.bigFive?.extraversion ?? 50,
      sinceLastMessageMs: last ? now.getTime() - last.createdAt.getTime() : null,
    });
    if (random() >= chance) {
      skip('這次沒有想傳', chance);
      continue;
    }
    await enqueue({ kind: 'proactive', avatarId: avatar.id, conversationId }, Math.round(random() * SPREAD_MS));
    decisions.push({ avatarId: avatar.id, action: 'enqueued', reason: '決定主動傳訊息', chance });
  }
  return decisions;
}
