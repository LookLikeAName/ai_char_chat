import { and, eq } from 'drizzle-orm';
import {
  applyDeltas,
  decayMood,
  EVENT_LABELS,
  FAMILIARITY_DAILY_CAP,
  FAMILIARITY_STAGES,
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

/** 資料列 → 狀態；心動只有對玩家的才有 */
export function relationshipState(row: RelationshipRow): RelationshipState {
  return {
    stage: row.stage,
    affinity: row.affinity,
    trust: row.trust,
    ...(row.target === USER_TARGET ? { romance: row.romance } : {}),
  };
}

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
    // 心動只追蹤對玩家的
    .values({ avatarId, target, stage: initial, ...v, romance: target === USER_TARGET ? v.romance : 0 })
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
  d: { affinity?: number; trust?: number; romance?: number; event?: RelationshipEventType | null; note?: string },
  warmUp: 'slow' | 'medium' | 'fast' = 'medium',
  target = USER_TARGET,
): Promise<{ before: RelationshipState; after: RelationshipState }> {
  const row = await getRelationship(db, avatarId, target);
  const before = relationshipState(row);
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

/**
 * avatar 之間在群組裡一起聊天：還不熟（陌生、認識）的話自然變熟一點，每一對每天有上限。
 * day 是當地日期；沒有變化時回傳 null。
 */
export async function growFamiliarity(
  db: Db,
  avatarId: string,
  otherId: string,
  day: string,
  warmUp: 'slow' | 'medium' | 'fast' = 'medium',
): Promise<{ before: RelationshipState; after: RelationshipState } | null> {
  const row = await getRelationship(db, avatarId, `avatar:${otherId}`, 'stranger');
  if (!FAMILIARITY_STAGES.includes(row.stage)) return null;
  const count = row.familiarity?.day === day ? row.familiarity.count : 0;
  if (count >= FAMILIARITY_DAILY_CAP) return null;
  const before: RelationshipState = { stage: row.stage, affinity: row.affinity, trust: row.trust };
  const after = applyDeltas(before, { affinity: 1, trust: 1 }, warmUp);
  const events = [...row.events];
  if (after.stage !== before.stage) {
    events.push({ type: 'reconciled', note: '在群組裡聊著聊著熟了起來', at: new Date().toISOString(), from: before.stage, to: after.stage });
  }
  await db
    .update(relationships)
    .set({ ...after, events: events.slice(-MAX_EVENTS), familiarity: { day, count: count + 1 }, updatedAt: new Date() })
    .where(eq(relationships.id, row.id));
  return { before, after };
}
