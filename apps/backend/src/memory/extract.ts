// 記憶萃取：對話告一段落（最後一則訊息後 10 分鐘，或累積 30 則）時，
// 請系統工具模型以 avatar 的角度挑出值得記住的事。重複觸發是安全的（以 memory_up_to 記錄處理到哪）。
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import type { AppSettings } from '@acc/shared';
import type { Db } from '../db/client.ts';
import { avatars, conversationMembers, conversations, messages } from '../db/schema.ts';
import { HttpError } from '../errors.ts';
import { callUtility, parseJsonObject } from '../persona/utility.ts';
import type { CallContext } from '../services/llmCall.ts';
import { formatNow } from '../reply/prompt.ts';
import type { Embedder } from './embedder.ts';
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
  if (!settings.utilityLlm) throw new HttpError(400, '沒有系統工具模型，無法整理記憶');

  const avatar = member.avatar;
  const names = new Map<string, string>([[avatar.id, avatar.name]]);
  const transcript = rows
    .map((m) => {
      const who = m.senderType === 'user' ? '對方' : m.senderAvatarId === avatar.id ? '我' : (names.get(m.senderAvatarId ?? '') ?? '其他人');
      return `[${formatNow(m.createdAt, settings.timezone)}] ${who}：${m.content}`;
    })
    .join('\n');
  const impression = await latestImpression(db, avatar.id);

  const content = `你是「${avatar.name}」（${avatar.bio || '沒有簡介'}）。下面是你和對方最近的聊天紀錄。
${impression ? `\n你原本對對方的印象：${impression.content}\n` : ''}
# 聊天紀錄（「我」是你，「對方」是玩家）
${transcript}

# 任務
以你（${avatar.name}）的角度，挑出之後值得記得的事，最多 ${MAX_MEMORIES} 件：
- 對方的近況、計畫、喜好、在意的事、說過的重要的話
- 你們之間發生的事（約定、玩笑梗、吵架、感動的時刻）
- 你自己說過、之後要記得的事（例如答應了什麼）
不要記沒有資訊量的寒暄。每件寫成一句完整的話，包含具體細節與時間（例如「對方說下週二要去面試，很緊張」）。
importance：1 = 小事，5 = 值得記得，10 = 非常重要、會一直記得。

# 輸出格式
{"memories": [{"content": "…", "importance": 5}]}；沒有值得記的就輸出 {"memories": []}。`;

  const text = await callUtility(ctx, settings, { system: '你負責整理角色的記憶。只輸出 JSON。', messages: [{ role: 'user', content }] }, 'memory.extract');
  const out = parseJsonObject(text);
  const items = (Array.isArray(out?.memories) ? out.memories : [])
    .filter((m): m is { content: string; importance?: number } => !!m && typeof (m as { content?: unknown }).content === 'string')
    .map((m) => ({ content: m.content.trim().slice(0, 500), importance: Number(m.importance) || 5 }))
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
      sourceConversationId: conversationId,
      visibility: member.type === 'dm' ? 'private' : `group:${conversationId}`,
    })),
  );
  await db
    .update(conversationMembers)
    .set({ memoryUpTo: last.createdAt })
    .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.avatarId, avatarId)));
  return 'done';
}
