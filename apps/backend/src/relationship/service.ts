import { and, eq } from 'drizzle-orm';
import {
  applyDeltas,
  decayMood,
  EVENT_LABELS,
  INITIAL_VALUES,
  NEUTRAL_MOOD,
  type InitialStage,
  type Mood,
  type RelationshipEventRecord,
  type RelationshipEventType,
  type RelationshipState,
} from '@acc/shared';
import type { Db } from '../db/client.ts';
import { avatarState, relationships } from '../db/schema.ts';

export const USER_TARGET = 'user';
const MAX_EVENTS = 50;

export type RelationshipRow = typeof relationships.$inferSelect;

/** 取得關係；還沒有時依初始階段建立 */
export async function getRelationship(
  db: Db,
  avatarId: string,
  target = USER_TARGET,
  initial: InitialStage = 'stranger',
): Promise<RelationshipRow> {
  const [row] = await db
    .select()
    .from(relationships)
    .where(and(eq(relationships.avatarId, avatarId), eq(relationships.target, target)));
  if (row) return row;
  const v = INITIAL_VALUES[initial];
  const [created] = await db
    .insert(relationships)
    .values({ avatarId, target, stage: initial, ...v })
    .onConflictDoNothing()
    .returning();
  return created ?? (await getRelationship(db, avatarId, target, initial));
}

export async function resetRelationship(db: Db, avatarId: string, stage: InitialStage, target = USER_TARGET) {
  await db.delete(relationships).where(and(eq(relationships.avatarId, avatarId), eq(relationships.target, target)));
  return getRelationship(db, avatarId, target, stage);
}

/** 套用一次互動的結果；回傳新的狀態與是否換了階段 */
export async function applyInteraction(
  db: Db,
  avatarId: string,
  d: { affinity?: number; trust?: number; event?: RelationshipEventType | null; note?: string },
  warmUp: 'slow' | 'medium' | 'fast' = 'medium',
  target = USER_TARGET,
): Promise<{ before: RelationshipState; after: RelationshipState }> {
  const row = await getRelationship(db, avatarId, target);
  const before: RelationshipState = { stage: row.stage, affinity: row.affinity, trust: row.trust };
  const after = applyDeltas(before, d, warmUp);
  const events = [...row.events];
  if (d.event || after.stage !== before.stage) {
    const record: RelationshipEventRecord = {
      type: d.event ?? (after.affinity < before.affinity ? 'conflict' : 'reconciled'),
      note: d.note?.trim() || (d.event ? EVENT_LABELS[d.event] : '關係有了變化'),
      at: new Date().toISOString(),
      ...(after.stage !== before.stage ? { from: before.stage, to: after.stage } : {}),
    };
    events.push(record);
  }
  await db
    .update(relationships)
    .set({ ...after, events: events.slice(-MAX_EVENTS), updatedAt: new Date() })
    .where(eq(relationships.id, row.id));
  return { before, after };
}

export async function getMood(db: Db, avatarId: string, now = new Date()): Promise<Mood> {
  const [row] = await db.select().from(avatarState).where(eq(avatarState.avatarId, avatarId));
  return row ? decayMood(row.mood, row.moodUpdatedAt, now) : NEUTRAL_MOOD;
}

export async function setMood(db: Db, avatarId: string, mood: Mood): Promise<void> {
  await db
    .insert(avatarState)
    .values({ avatarId, mood, moodUpdatedAt: new Date() })
    .onConflictDoUpdate({ target: avatarState.avatarId, set: { mood, moodUpdatedAt: new Date() } });
}
