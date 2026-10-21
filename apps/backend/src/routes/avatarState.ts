import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { eventsSoFar, intimacyLevel, localClock, relationshipPatchSchema, resetRelationshipSchema, type AvatarStateDto } from '@acc/shared';
import { avatars, memories } from '../db/schema.ts';
import { notFound, parseBody } from '../errors.ts';
import { getLifeLog } from '../life/lifeLog.ts';
import { embedderFromSettings } from '../memory/embedder.ts';
import { reflect } from '../memory/reflect.ts';
import { latestImpression } from '../memory/store.ts';
import { logEvent } from '../observability.ts';
import { loadProfile } from '../profile/service.ts';
import { assertStageAllowed, getMood, getRelationship, patchRelationship, relationshipState, resetRelationship } from '../relationship/service.ts';
import { loadSettings } from '../services/settings.ts';
import { avatarUsageToday } from '../services/usage.ts';

const idParams = z.object({ id: z.uuid() });
const memoryParams = z.object({ id: z.uuid(), memoryId: z.uuid() });
const MEMORY_LIST = 50;

export async function avatarStateRoutes(app: FastifyInstance) {
  const { db, events } = app.deps;

  async function assertAvatar(id: string) {
    const [a] = await db.select({ id: avatars.id }).from(avatars).where(eq(avatars.id, id));
    if (!a) throw notFound('avatar');
  }

  app.get('/avatars/:id/state', async (req): Promise<AvatarStateDto> => {
    const { id } = parseBody(idParams, req.params);
    await assertAvatar(id);
    const settings = await loadSettings(db);
    const { timezone } = settings;
    const clock = localClock(new Date(), timezone);
    const [mood, rel, impression, rows, log, usageToday] = await Promise.all([
      getMood(db, id),
      getRelationship(db, id),
      latestImpression(db, id),
      db
        .select()
        .from(memories)
        .where(and(eq(memories.avatarId, id), eq(memories.kind, 'event')))
        .orderBy(desc(memories.createdAt))
        .limit(MEMORY_LIST),
      getLifeLog(db, id, clock.date),
      avatarUsageToday(db, id),
    ]);
    const [avatar] = await db.select({ persona: avatars.persona }).from(avatars).where(eq(avatars.id, id));
    const intimacy = settings.adultContent
      ? intimacyLevel({
          relationship: relationshipState(rel),
          openness: avatar?.persona.intimacy?.openness,
          mood,
          romancePref: (await loadProfile(db)).preferences?.romance,
        })
      : null;
    return {
      mood,
      intimacy,
      relationship: { stage: rel.stage, affinity: rel.affinity, trust: rel.trust, romance: rel.romance, events: rel.events },
      impression: impression?.content ?? null,
      memories: rows.map((m) => ({
        id: m.id,
        kind: m.kind,
        content: m.content,
        importance: m.importance,
        createdAt: m.createdAt.toISOString(),
      })),
      today: log ? eventsSoFar(log, clock.hhmm) : [],
      usageToday,
    };
  });

  /** 玩家可以刪掉不想讓 avatar 記得的事 */
  app.delete('/avatars/:id/memories/:memoryId', async (req, reply) => {
    const { id, memoryId } = parseBody(memoryParams, req.params);
    await db.delete(memories).where(and(eq(memories.id, memoryId), eq(memories.avatarId, id)));
    await events.publish({ type: 'avatar.state.changed', avatarId: id });
    return reply.status(204).send();
  });

  app.post('/avatars/:id/relationship/reset', async (req) => {
    const { id } = parseBody(idParams, req.params);
    const { stage } = parseBody(resetRelationshipSchema, req.body);
    await assertAvatar(id);
    assertStageAllowed(stage, (await loadSettings(db)).adultContent);
    await resetRelationship(db, id, stage);
    await events.publish({ type: 'avatar.state.changed', avatarId: id });
    return { ok: true };
  });

  /** 手動調整和玩家的關係：階段、好感、信任、心動 */
  app.patch('/avatars/:id/relationship', async (req) => {
    const { id } = parseBody(idParams, req.params);
    const patch = parseBody(relationshipPatchSchema, req.body);
    await assertAvatar(id);
    if (patch.stage) assertStageAllowed(patch.stage, (await loadSettings(db)).adultContent);
    const row = await patchRelationship(db, id, patch);
    await logEvent({ category: 'state', type: 'state.manual', avatarId: id, message: row.events.at(-1)?.note ?? '手動調整關係', data: patch });
    await events.publish({ type: 'avatar.state.changed', avatarId: id });
    return { stage: row.stage, affinity: row.affinity, trust: row.trust, romance: row.romance };
  });

  /** 立刻整理一次印象（不等每日排程） */
  app.post('/avatars/:id/reflect', async (req) => {
    const { id } = parseBody(idParams, req.params);
    await assertAvatar(id);
    const settings = await loadSettings(db);
    const embedder = await embedderFromSettings(db, app.deps.box, settings, app.deps.fetchFn).catch(() => null);
    const updated = await reflect(app.deps, settings, embedder, id, { force: true });
    if (updated) await events.publish({ type: 'avatar.state.changed', avatarId: id });
    return { updated };
  });
}
