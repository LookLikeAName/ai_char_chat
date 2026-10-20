// 記憶萃取：對話告一段落（最後一則訊息後 10 分鐘，或累積 30 則）時，
// 請系統工具模型以 avatar 的角度挑出值得記住的事。重複觸發是安全的（以 memory_up_to 記錄處理到哪）。
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { shownName, utilityBinding, type AppSettings } from '@acc/shared';
import type { Db } from '../db/client.ts';
import { avatars, conversationMembers, conversations, messages, type MessageImage } from '../db/schema.ts';
import { HttpError } from '../errors.ts';
import { callUtility, parseJsonObject } from '../persona/utility.ts';
import { logEvent } from '../observability.ts';
import type { CallContext } from '../services/llmCall.ts';
import { formatNow } from '../reply/prompt.ts';
import type { Embedder } from './embedder.ts';
import { loadProfile } from '../profile/service.ts';
import { addMemories, latestImpression } from './store.ts';

export const EXTRACT_IDLE_MS = 10 * 60 * 1000;
export const EXTRACT_MAX_PENDING = 30;
const MAX_MEMORIES = 8;
const MAX_TRANSCRIPT = 200;

export type ExtractResult = 'done' | 'nothing' | 'later';

export async function extractMemories(
  ctx: CallContext,
  settings: AppSettings,
  embedder: Embedder | null,
  avatarId: string,
  conversationId: string,
  now = new Date(),
  idleMs = EXTRACT_IDLE_MS,
): Promise<ExtractResult> {
  const db: Db = ctx.db;
  const [member] = await db
    .select({ memoryUpTo: conversationMembers.memoryUpTo, type: conversations.type, avatar: avatars })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .innerJoin(avatars, eq(avatars.id, conversationMembers.avatarId))
    .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.avatarId, avatarId)));
  if (!member) return 'nothing';

  const rows = await db
    .select({
      senderType: messages.senderType,
      senderAvatarId: messages.senderAvatarId,
      content: messages.content,
      createdAt: messages.createdAt,
      image: sql<MessageImage | null>`${messages.meta}->'image'`,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        inArray(messages.senderType, ['user', 'avatar']),
        member.memoryUpTo ? gt(messages.createdAt, member.memoryUpTo) : undefined,
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.seq))
    .limit(MAX_TRANSCRIPT);
  if (!rows.length) return 'nothing';
  const last = rows.at(-1)!;
  // 對話還在進行中：等下一次（每次回覆後都會再排一次）
  if (now.getTime() - last.createdAt.getTime() < idleMs && rows.length < EXTRACT_MAX_PENDING) return 'later';
  if (!utilityBinding(settings, 'memory')) throw new HttpError(400, '沒有系統工具模型，無法整理記憶');

  const avatar = member.avatar;
  const others = await db
    .select({ id: avatars.id, name: avatars.name, displayName: avatars.displayName })
    .from(conversationMembers)
    .innerJoin(avatars, eq(avatars.id, conversationMembers.avatarId))
    .where(eq(conversationMembers.conversationId, conversationId));
  const names = new Map<string, string>(others.map((o) => [o.id, shownName(o)]));
  /** 模型寫的「關於誰」→ user、self 或 avatar:<id>；認不出來的當作關於對方 */
  const aboutOf = (v: unknown): string => {
    const t = typeof v === 'string' ? v.trim() : '';
    if (t === '我' || t === avatar.name || t === shownName(avatar)) return 'self';
    const other = others.find((o) => o.id !== avatar.id && (t === o.name || t === shownName(o)));
    return other ? `avatar:${other.id}` : 'user';
  };
  const transcript = rows
    .map((m) => {
      const who = m.senderType === 'user' ? '對方' : m.senderAvatarId === avatar.id ? '我' : (names.get(m.senderAvatarId ?? '') ?? '其他人');
      const img = m.image ? `［${m.senderType === 'avatar' ? '照片' : '圖片'}：${m.image.description ?? m.image.caption ?? '看不到內容'}］` : '';
      return `[${formatNow(m.createdAt, settings.timezone)}] ${who}：${[img, m.content].filter(Boolean).join(' ')}`;
    })
    .join('\n');
  const impression = await latestImpression(db, avatar.id);
  const profile = await loadProfile(db);
  const nickname = profile.preferences?.nickname;
  const group = member.type === 'group';
  const otherNames = others.filter((o) => o.id !== avatar.id).map((o) => shownName(o));

  const where = group ? '在群組裡和大家' : '和對方';
  const content = `你是「${avatar.name}」（${avatar.bio || '沒有簡介'}）。下面是你${where}最近的聊天紀錄。
「對方」是和你用通訊軟體聊天的那個人${nickname ? `，名字是「${nickname}」` : ''}${avatar.persona.relationship?.withUser ? `（${avatar.persona.relationship.withUser}）` : ''}。${
    group ? `\n群組裡的其他成員：${otherNames.join('、')}。` : ''
  }
${impression ? `\n你原本對對方的印象：${impression.content}\n` : ''}
# 聊天紀錄（「我」是你，「對方」是${nickname ? `「${nickname}」` : '和你聊天的人'}）
${transcript}

# 任務
以你（${avatar.name}）的角度，挑出之後值得記得的事，最多 ${MAX_MEMORIES} 件：
- 對方的近況、計畫、喜好、在意的事、說過的重要的話
- 你們之間發生的事（約定、玩笑梗、吵架、感動的時刻）
- 你自己說過、之後要記得的事（例如答應了什麼）${
    member.type === 'group'
      ? '\n- 群組裡其他成員的事：他們是做什麼的、喜好、近況、你們之間的互動（寫出名字，例如「阿哲說他在設計公司上班，很怕冷」）'
      : ''
  }
不要記沒有資訊量的寒暄。每件寫成一句完整的話，包含具體細節與時間（例如「對方說下週二要去面試，很緊張」）。
importance：1 = 小事，5 = 值得記得，10 = 非常重要、會一直記得。
about：這件事主要是關於誰：「對方」、「我」${group ? '，或其他成員的名字' : ''}。

# 輸出格式
{"memories": [{"content": "…", "importance": 5, "about": "對方"}]}；沒有值得記的就輸出 {"memories": []}。`;

  const text = await callUtility(ctx, settings, { system: '你負責整理角色的記憶。只輸出 JSON。', messages: [{ role: 'user', content }] }, 'memory.extract', { avatarId });
  const out = parseJsonObject(text);
  const items = (Array.isArray(out?.memories) ? out.memories : [])
    .filter((m): m is { content: string; importance?: number; about?: unknown } => !!m && typeof (m as { content?: unknown }).content === 'string')
    .map((m) => ({ content: m.content.trim().slice(0, 500), importance: Number(m.importance) || 5, about: aboutOf(m.about) }))
    .filter((m) => m.content)
    .slice(0, MAX_MEMORIES);

  await addMemories(
    db,
    embedder,
    items.map((m) => ({
      avatarId: avatar.id,
      kind: 'event' as const,
      content: m.content,
      importance: m.importance,
      about: m.about,
      sourceConversationId: conversationId,
      visibility: member.type === 'dm' ? 'private' : `group:${conversationId}`,
    })),
  );
  await logEvent({
    category: 'memory',
    type: 'memory.extract',
    avatarId: avatar.id,
    conversationId,
    message: `${avatar.name}：從 ${rows.length} 則訊息整理出 ${items.length} 件記憶`,
    data: { memories: items },
  });
  await db
    .update(conversationMembers)
    .set({ memoryUpTo: last.createdAt })
    .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.avatarId, avatarId)));
  return 'done';
}
