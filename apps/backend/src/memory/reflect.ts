// 反思：把最近的記憶整合成對玩家的整體印象（每天最多一次）。
import { and, desc, eq, gt } from 'drizzle-orm';
import { STAGE_LABELS, type AppSettings } from '@acc/shared';
import type { Db } from '../db/client.ts';
import { avatars, avatarState, memories } from '../db/schema.ts';
import { callUtility } from '../persona/utility.ts';
import { getMood, getRelationship } from '../relationship/service.ts';
import { logEvent } from '../observability.ts';
import type { CallContext } from '../services/llmCall.ts';
import type { Embedder } from './embedder.ts';
import { addMemories, latestImpression } from './store.ts';

export const REFLECT_INTERVAL_MS = 20 * 60 * 60 * 1000;
const MIN_NEW_MEMORIES = 3;

/** 回傳是否產生了新的印象 */
export async function reflect(
  ctx: CallContext,
  settings: AppSettings,
  embedder: Embedder | null,
  avatarId: string,
  opts: { now?: Date; force?: boolean } = {},
): Promise<boolean> {
  const now = opts.now ?? new Date();
  const db: Db = ctx.db;
  const [avatar] = await db.select().from(avatars).where(eq(avatars.id, avatarId));
  if (!avatar || !settings.utilityLlm) return false;
  const [state] = await db.select().from(avatarState).where(eq(avatarState.avatarId, avatarId));
  if (!opts.force && state?.reflectedAt && now.getTime() - state.reflectedAt.getTime() < REFLECT_INTERVAL_MS) return false;

  const since = state?.reflectedAt ?? new Date(0);
  const fresh = await db
    .select()
    .from(memories)
    .where(and(eq(memories.avatarId, avatarId), eq(memories.kind, 'event'), gt(memories.createdAt, since)))
    .orderBy(desc(memories.importance), desc(memories.createdAt))
    .limit(30);
  if (fresh.length < (opts.force ? 1 : MIN_NEW_MEMORIES)) return false;

  const previous = await latestImpression(db, avatarId);
  const rel = await getRelationship(db, avatarId);
  const mood = await getMood(db, avatarId, now);
  const content = `你是「${avatar.name}」（${avatar.bio || '沒有簡介'}）。
目前你和對方的關係：${STAGE_LABELS[rel.stage]}；你現在的心情：${mood.label}。
${previous ? `你原本對對方的印象：${previous.content}` : '你還沒有整理過對對方的印象。'}

# 最近記得的事
${fresh.map((m) => `- ${m.content}`).join('\n')}

# 任務
用你的口吻、第一人稱，寫一段 100～200 字的「我對對方的印象」：他是個怎樣的人、你們現在的感覺、你在意或好奇他的地方。
要延續原本的印象，有新的觀察就修正；不要條列，只輸出這段文字。`;

  const text = await callUtility(
    ctx,
    settings,
    { system: '你在幫角色整理心裡的想法。', messages: [{ role: 'user', content }] },
    'memory.reflect',
    { json: false, avatarId },
  );
  const impression = text.trim().slice(0, 1000);
  if (!impression) return false;
  await addMemories(db, embedder, [{ avatarId, kind: 'impression', content: impression, importance: 8 }]);
  await logEvent({
    category: 'memory',
    type: 'memory.reflect',
    avatarId,
    message: `${avatar.name}：整合 ${fresh.length} 件新記憶，更新了對玩家的印象`,
    data: { impression },
  });
  await db
    .insert(avatarState)
    .values({ avatarId, mood, reflectedAt: now })
    .onConflictDoUpdate({ target: avatarState.avatarId, set: { reflectedAt: now } });
  return true;
}
