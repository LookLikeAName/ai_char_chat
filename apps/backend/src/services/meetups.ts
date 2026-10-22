// 見面：開始、結束、找出進行中的那一場。
import { and, desc, eq, isNull } from 'drizzle-orm';
import { MEETUP_MAX_MS, type MeetupDto } from '@acc/shared';
import type { Db } from '../db/client.ts';
import { meetups } from '../db/schema.ts';
import type { EventPublisher } from '../events/bus.ts';
import { logEvent } from '../observability.ts';
import { postMessage } from './messages.ts';

export type MeetupRow = typeof meetups.$inferSelect;

export function meetupToDto(m: MeetupRow): MeetupDto {
  return {
    id: m.id,
    conversationId: m.conversationId,
    place: m.place,
    note: m.note,
    startedAt: m.startedAt.toISOString(),
    endedAt: m.endedAt?.toISOString() ?? null,
    endedBy: m.endedBy ?? null,
  };
}

/** 進行中的見面；開太久（忘了結束）的會在這裡自動結束 */
export async function activeMeetup(db: Db, conversationId: string, now = new Date()): Promise<MeetupRow | null> {
  const [m] = await db
    .select()
    .from(meetups)
    .where(and(eq(meetups.conversationId, conversationId), isNull(meetups.endedAt)))
    .limit(1);
  if (!m) return null;
  if (now.getTime() - m.startedAt.getTime() > MEETUP_MAX_MS) {
    await db.update(meetups).set({ endedAt: new Date(m.startedAt.getTime() + MEETUP_MAX_MS) }).where(eq(meetups.id, m.id));
    return null;
  }
  return m;
}

/** 對話裡的每一場見面（由舊到新），對話紀錄用來標出哪些是見面時說的 */
export async function meetupsOf(db: Db, conversationId: string, limit = 20): Promise<MeetupRow[]> {
  const rows = await db.select().from(meetups).where(eq(meetups.conversationId, conversationId)).orderBy(desc(meetups.startedAt)).limit(limit);
  return rows.reverse();
}

export function minutesBetween(a: Date, b: Date): number {
  return Math.max(1, Math.round((b.getTime() - a.getTime()) / 60_000));
}

/** 結束見面，留一則系統訊息；已經結束的回傳 null */
export async function endMeetup(
  db: Db,
  events: EventPublisher,
  meetup: MeetupRow,
  by: 'user' | 'avatar',
  opts: { now?: Date; avatarName?: string } = {},
): Promise<MeetupRow | null> {
  const now = opts.now ?? new Date();
  const [ended] = await db
    .update(meetups)
    .set({ endedAt: now, endedBy: by })
    .where(and(eq(meetups.id, meetup.id), isNull(meetups.endedAt)))
    .returning();
  if (!ended) return null;
  const who = by === 'avatar' && opts.avatarName ? `${opts.avatarName}先離開了，` : '';
  await postMessage(db, events, {
    conversationId: meetup.conversationId,
    senderType: 'system',
    content: `${who}在${meetup.place}的見面結束了（${minutesBetween(meetup.startedAt, now)} 分鐘）`,
    meta: { systemKind: 'notice', meetupId: meetup.id },
  });
  await logEvent({
    category: 'reply',
    type: 'meetup.ended',
    avatarId: meetup.avatarId,
    conversationId: meetup.conversationId,
    message: `在${meetup.place}的見面結束了（${by === 'avatar' ? 'avatar 先離開' : '玩家結束'}）`,
  });
  await events.publish({ type: 'conversations.changed' });
  return ended;
}
