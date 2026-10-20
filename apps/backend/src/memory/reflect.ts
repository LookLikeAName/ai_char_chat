// 反思：把最近的記憶整合成對玩家的整體印象（每天最多一次）。
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { STAGE_LABELS, utilityBinding, type AppSettings } from '@acc/shared';
import type { Db } from '../db/client.ts';
import { avatars, avatarState, memories } from '../db/schema.ts';
import { callUtility } from '../persona/utility.ts';
import { loadProfile } from '../profile/service.ts';
import { formatNow, userSection } from '../reply/prompt.ts';
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
  if (!avatar || !utilityBinding(settings, 'memory')) return false;
  const [state] = await db.select().from(avatarState).where(eq(avatarState.avatarId, avatarId));
  if (!opts.force && state?.reflectedAt && now.getTime() - state.reflectedAt.getTime() < REFLECT_INTERVAL_MS) return false;

  const since = state?.reflectedAt ?? new Date(0);
  const fresh = await db
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.avatarId, avatarId),
        eq(memories.kind, 'event'),
        inArray(memories.about, ['user', 'self']),
        gt(memories.createdAt, since),
      ),
    )
    .orderBy(desc(memories.importance), desc(memories.createdAt))
    .limit(30);
  if (fresh.length < (opts.force ? 1 : MIN_NEW_MEMORIES)) return false;

  const previous = await latestImpression(db, avatarId);
  const rel = await getRelationship(db, avatarId);
  const mood = await getMood(db, avatarId, now);
  const profile = await loadProfile(db);
  const p = avatar.persona;
  const voice = [
    p.personality?.traits?.length ? `個性：${p.personality.traits.join('、')}` : '',
    p.speech?.tone ? `說話方式：${p.speech.tone}` : '',
  ].filter(Boolean);
  // 跟聊天時一樣，依關係深淺決定知道對方多少
  const aboutUser = profile.preferences
    ? userSection({ preferences: profile.preferences, summary: profile.summary, results: profile.results }, rel.stage)
    : '你對對方的基本資料還不清楚。';
  const content = `你是「${avatar.name}」（${avatar.bio || '沒有簡介'}）。${voice.length ? `\n${voice.join('\n')}` : ''}
下面的「對方」指的是和你用通訊軟體聊天的那個人（不是群組裡的其他成員）。

# 你和對方
${p.relationship?.withUser ? `${p.relationship.withUser}\n` : ''}${p.relationship?.callsUser ? `你稱呼對方「${p.relationship.callsUser}」。\n` : ''}目前的關係：${STAGE_LABELS[rel.stage]}（好感 ${rel.affinity}/100、信任 ${rel.trust}/100）；你現在的心情：${mood.label}。

# 你知道的對方
${aboutUser}

# 你原本對對方的印象
${previous ? previous.content : '（還沒有整理過）'}

# 最近記得的事
${fresh.map((m) => `- ${formatNow(m.createdAt, settings.timezone)}：${m.content}`).join('\n')}

# 任務
用你的口吻、第一人稱，寫一段 100～200 字的「我對對方的印象」：對方是個怎樣的人、你們現在的感覺、你在意或好奇對方的地方。
- 延續原本的印象，有新的觀察就修正；符合你們目前的關係，不要比實際更熟或更陌生。
- 只根據上面寫到的事，不要編造沒發生過的事。
- 不要提到測驗、問卷或分數；不要條列，只輸出這段文字。`;

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
