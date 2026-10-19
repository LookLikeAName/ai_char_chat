import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { sendMessageSchema, type ConversationDto } from '@acc/shared';
import { avatars, conversationMembers, conversations, messages } from '../db/schema.ts';
import { notFound, parseBody } from '../errors.ts';
import { debounceMs } from '../reply/timing.ts';
import { mediaUrl } from '../services/avatars.ts';
import { messageToDto, postMessage } from '../services/messages.ts';

const idParams = z.object({ id: z.uuid() });
const pageQuery = z.object({
  before: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function conversationRoutes(app: FastifyInstance) {
  const { db, events, jobs } = app.deps;

  app.get('/conversations', async (): Promise<ConversationDto[]> => {
    const convs = await db.select().from(conversations);
    if (!convs.length) return [];
    const ids = convs.map((c) => c.id);
    const members = await db
      .select({
        conversationId: conversationMembers.conversationId,
        avatarId: avatars.id,
        name: avatars.name,
        imagePath: avatars.imagePath,
        seenUpTo: conversationMembers.seenUpTo,
      })
      .from(conversationMembers)
      .innerJoin(avatars, eq(avatars.id, conversationMembers.avatarId))
      .where(inArray(conversationMembers.conversationId, ids));
    // 每個對話的最後一則訊息
    const last = await db
      .selectDistinctOn([messages.conversationId])
      .from(messages)
      .where(inArray(messages.conversationId, ids))
      .orderBy(messages.conversationId, desc(messages.createdAt), desc(messages.seq));
    const lastBy = new Map(last.map((m) => [m.conversationId, m]));
    // 未讀：玩家上次看過之後 avatar 傳來的訊息
    const unread = await db
      .select({ conversationId: messages.conversationId, n: count() })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(
        and(
          inArray(messages.conversationId, ids),
          eq(messages.senderType, 'avatar'),
          or(isNull(conversations.userReadAt), gt(messages.createdAt, conversations.userReadAt)),
        ),
      )
      .groupBy(messages.conversationId);
    const unreadBy = new Map(unread.map((u) => [u.conversationId, Number(u.n)]));

    return convs
      .map((c): ConversationDto => {
        const mem = members.filter((m) => m.conversationId === c.id);
        const lastMsg = lastBy.get(c.id);
        const dmAvatar = c.type === 'dm' ? mem[0] : undefined;
        return {
          id: c.id,
          type: c.type,
          title: dmAvatar?.name ?? c.title ?? mem.map((m) => m.name).join('、'),
          imageUrl: mediaUrl(dmAvatar?.imagePath ?? c.imagePath),
          memberAvatarIds: mem.map((m) => m.avatarId),
          lastMessage: lastMsg ? messageToDto(lastMsg) : null,
          lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
          unreadCount: unreadBy.get(c.id) ?? 0,
          seenUpTo: dmAvatar?.seenUpTo?.toISOString() ?? null,
        };
      })
      .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
  });

  app.get('/conversations/:id/messages', async (req) => {
    const { id } = parseBody(idParams, req.params);
    const { before, limit } = parseBody(pageQuery, req.query);
    await assertConversation(id);
    const rows = await db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, id), before ? lt(messages.createdAt, new Date(before)) : undefined))
      .orderBy(desc(messages.createdAt), desc(messages.seq))
      .limit(limit);
    return { messages: rows.reverse().map(messageToDto), hasMore: rows.length === limit };
  });

  app.post('/conversations/:id/messages', async (req, reply) => {
    const { id } = parseBody(idParams, req.params);
    const { content } = parseBody(sendMessageSchema, req.body);
    await assertConversation(id);
    const dto = await postMessage(db, events, { conversationId: id, senderType: 'user', content });
    // 延遲一下再處理：玩家連續傳的訊息會合併成一次回覆
    await jobs.add({ kind: 'reply', conversationId: id }, { delayMs: debounceMs(Math.random) });
    return reply.status(201).send(dto);
  });

  /** 玩家看過這個對話（清除未讀） */
  app.post('/conversations/:id/read', async (req, reply) => {
    const { id } = parseBody(idParams, req.params);
    await assertConversation(id);
    await db.update(conversations).set({ userReadAt: new Date() }).where(eq(conversations.id, id));
    await events.publish({ type: 'conversations.changed' });
    return reply.status(204).send();
  });

  /** 回覆失敗後重試：移除錯誤訊息，重新投遞 */
  app.post('/conversations/:id/retry', async (req, reply) => {
    const { id } = parseBody(idParams, req.params);
    await assertConversation(id);
    await db
      .delete(messages)
      .where(and(eq(messages.conversationId, id), eq(messages.senderType, 'system'), sql`${messages.meta}->>'systemKind' = 'error'`));
    await events.publish({ type: 'messages.changed', conversationId: id });
    await jobs.add({ kind: 'reply', conversationId: id });
    return reply.status(202).send();
  });

  async function assertConversation(id: string) {
    const [c] = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, id));
    if (!c) throw notFound('對話');
  }
}
