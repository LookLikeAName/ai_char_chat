// 玩家送出訊息時，決定 avatar 什麼時候會「看到」：
// 依作息（空閒／忙碌／睡覺）、回訊息習慣、還沒讀的訊息累積的壓力，以及回覆節奏設定。
// 預計時間存在 conversation_members.reply_due_at，新的訊息只會讓它提前，不會延後。
import { and, desc, eq, gt } from 'drizzle-orm';
import { availabilityAt, planSeen, SEEN_REASON_LABELS, STATUS_LABELS, type Availability, type SeenPlan } from '@acc/shared';
import type { Db } from '../db/client.ts';
import { avatars, conversationMembers, conversations, messages } from '../db/schema.ts';
import type { JobQueue } from '../jobs.ts';
import { logEvent } from '../observability.ts';
import { loadSettings } from '../services/settings.ts';
import type { Random } from './timing.ts';

/** avatar 最近幾分鐘內有傳過訊息，就是正在聊天中，會很快看到 */
export const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

export async function scheduleReply(
  db: Db,
  jobs: JobQueue,
  conversationId: string,
  opts: { now?: Date; random?: Random } = {},
): Promise<SeenPlan | null> {
  const now = opts.now ?? new Date();
  const random = opts.random ?? Math.random;
  const [row] = await db
    .select({ member: conversationMembers, avatar: avatars, type: conversations.type })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .innerJoin(avatars, eq(avatars.id, conversationMembers.avatarId))
    .where(eq(conversationMembers.conversationId, conversationId));
  // 群組在第 7 階段處理
  if (!row || row.type !== 'dm') return null;
  const { member, avatar } = row;
  const settings = await loadSettings(db);

  const unseen = await db
    .select({ content: messages.content })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.senderType, 'user'),
        member.seenUpTo ? gt(messages.createdAt, member.seenUpTo) : undefined,
      ),
    );
  const [lastAvatar] = await db
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.senderType, 'avatar')))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  // 正在聊天中：avatar 剛傳過訊息，或剛到預計時間、正在處理
  const due = member.replyDueAt;
  const processing = !!due && due <= now && now.getTime() - due.getTime() < ACTIVE_WINDOW_MS;
  const chatting = processing || (!!lastAvatar && now.getTime() - lastAvatar.createdAt.getTime() < ACTIVE_WINDOW_MS);
  const availability: Availability = chatting
    ? { status: 'free', activity: '', until: null }
    : availabilityAt(avatar.persona, now, settings.timezone);

  const plan = planSeen({
    availability,
    replyHabit: avatar.persona.routine?.replyHabit,
    pacing: settings.replyPacing,
    unseen: unseen.length ? unseen : [{ content: '' }],
    now,
    random,
  });

  // 已經排了更早的時間（而且還沒過期）就維持原本的
  const existing = member.replyDueAt;
  const minutes = (d: Date) => Math.round((d.getTime() - now.getTime()) / 6000) / 10;
  const data = {
    availability: { ...availability, until: availability.until?.toISOString() ?? null },
    chatting,
    pacing: settings.replyPacing,
    unseen: unseen.length,
    plan: { at: plan.at.toISOString(), reason: plan.reason },
    existing: existing?.toISOString() ?? null,
  };
  if (existing && existing.getTime() >= now.getTime() - 60_000 && existing <= plan.at) {
    await logEvent({
      category: 'reply',
      type: 'reply.kept',
      avatarId: avatar.id,
      conversationId,
      message: `${avatar.name}：已經排在 ${minutes(existing)} 分鐘後看到，這次算出 ${minutes(plan.at)} 分鐘，維持原本的`,
      data,
    });
    return { at: existing, reason: member.replyReason ?? plan.reason };
  }
  await logEvent({
    category: 'reply',
    type: 'reply.scheduled',
    avatarId: avatar.id,
    conversationId,
    message: `${avatar.name}（${chatting ? '聊天中' : STATUS_LABELS[availability.status]}${availability.activity ? `・${availability.activity}` : ''}）預計 ${minutes(plan.at)} 分鐘後看到：${SEEN_REASON_LABELS[plan.reason]}${existing ? '（提前）' : ''}`,
    data,
  });
  await db
    .update(conversationMembers)
    .set({ replyDueAt: plan.at, replyReason: plan.reason })
    .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.avatarId, avatar.id)));
  await jobs.add({ kind: 'reply', conversationId }, { delayMs: Math.max(0, plan.at.getTime() - now.getTime()) });
  return plan;
}
