// 每 15 分鐘：替每個 avatar 準備今天的生活日誌，並依機率決定要不要主動傳訊息給玩家。
import { and, desc, eq, inArray } from 'drizzle-orm';
import { availabilityAt, inTimeRange, localClock, proactiveChance, type AppSettings } from '@acc/shared';
import type { Db } from '../db/client.ts';
import { avatars, avatarState, conversationMembers, conversations, messages } from '../db/schema.ts';
import type { AgentJob } from '../jobs.ts';
import { ensureLifeLog } from '../life/lifeLog.ts';
import { loadProfile } from '../profile/service.ts';
import { getRelationship } from '../relationship/service.ts';
import { logEvent } from '../observability.ts';
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
  opts: { now?: Date; random?: () => number; /** 補上停機期間時不記每一次的檢查 */ quiet?: boolean } = {},
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

  // 玩家只想當朋友時，心動不會讓 avatar 更常找你
  const pref = (await loadProfile(db)).preferences?.romance;
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
      romance: pref === 'none' ? 0 : rel.romance,
    });
    if (random() >= chance) {
      skip('這次沒有想傳', chance);
      continue;
    }
    await enqueue({ kind: 'proactive', avatarId: avatar.id, conversationId }, Math.round(random() * SPREAD_MS));
    decisions.push({ avatarId: avatar.id, action: 'enqueued', reason: '決定主動傳訊息', chance });
  }
  decisions.push(...(await groupTick(db, settings, enqueue, now, random, clock, states)));

  if (!opts.quiet) await logEvent({
    category: 'proactive',
    type: 'proactive.tick',
    level: decisions.some((d) => d.action === 'enqueued') ? 'info' : 'debug',
    message: `主動發話檢查：${decisions.filter((d) => d.action === 'enqueued').length} / ${decisions.length} 個 avatar 決定傳訊息`,
    data: {
      decisions: decisions.map((d) => ({
        ...d,
        name: rows.find((r) => r.avatar.id === d.avatarId)?.avatar.name ?? d.avatarId,
        chance: d.chance === undefined ? undefined : Math.round(d.chance * 1000) / 1000,
      })),
    },
  });
  return decisions;
}

/** 群組沉寂超過這麼久，才會有人想開話題 */
const GROUP_QUIET_MS = 2 * 60 * 60 * 1000;

/** 群組：沉寂一陣子後，可能有人主動開話題（算在那個 avatar 的每日次數裡） */
async function groupTick(
  db: Db,
  settings: AppSettings,
  enqueue: (job: AgentJob, delayMs: number) => Promise<void>,
  now: Date,
  random: () => number,
  clock: ReturnType<typeof localClock>,
  states: (typeof avatarState.$inferSelect)[],
): Promise<TickDecision[]> {
  const out: TickDecision[] = [];
  if (!settings.proactive.enabled) return out;
  if (settings.quietHours.enabled && inTimeRange(clock.hhmm, settings.quietHours.start, settings.quietHours.end)) return out;
  const groups = await db.select().from(conversations).where(eq(conversations.type, 'group'));
  for (const g of groups) {
    const [last] = await db
      .select({ senderType: messages.senderType, meta: messages.meta, createdAt: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.conversationId, g.id), inArray(messages.senderType, ['user', 'avatar'])))
      .orderBy(desc(messages.createdAt), desc(messages.seq))
      .limit(1);
    // 有人剛說過話、或上一個話題沒人理（玩家還沒回）就不開新的
    if (last && (now.getTime() - last.createdAt.getTime() < GROUP_QUIET_MS || last.meta.proactive)) continue;
    const members = await db
      .select({ avatar: avatars })
      .from(conversationMembers)
      .innerJoin(avatars, eq(avatars.id, conversationMembers.avatarId))
      .where(eq(conversationMembers.conversationId, g.id));
    const chances: { id: string; chance: number }[] = [];
    for (const { avatar } of members) {
      if (!avatar.llm) continue;
      const st = states.find((s) => s.avatarId === avatar.id);
      if ((st?.proactiveDate === clock.date ? st.proactiveCount : 0) >= settings.proactive.dailyLimit) continue;
      const rel = await getRelationship(db, avatar.id);
      const chance =
        0.5 *
        proactiveChance({
          availability: availabilityAt(avatar.persona, now, settings.timezone),
          stage: rel.stage,
          extraversion: avatar.persona.personality?.bigFive?.extraversion ?? 50,
          sinceLastMessageMs: last ? now.getTime() - last.createdAt.getTime() : null,
        });
      if (chance > 0) chances.push({ id: avatar.id, chance });
    }
    // 至少一個人想開話題的機率；再依各自的機率挑一個人
    const total = 1 - chances.reduce((p, c) => p * (1 - c.chance), 1);
    if (!chances.length || random() >= total) continue;
    let r = random() * chances.reduce((s, c) => s + c.chance, 0);
    const who = chances.find((c) => (r -= c.chance) <= 0) ?? chances.at(-1)!;
    await enqueue({ kind: 'group.proactive', conversationId: g.id, avatarId: who.id }, Math.round(random() * SPREAD_MS));
    out.push({ avatarId: who.id, action: 'enqueued', reason: `在群組「${g.title ?? ''}」開話題`, chance: total });
  }
  return out;
}
