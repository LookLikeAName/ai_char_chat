import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { groupInputSchema, sendMessageSchema, type ConversationDto } from '@acc/shared';
import { avatars, conversationMembers, conversations, messages } from '../db/schema.ts';
import { HttpError, notFound, parseBody } from '../errors.ts';
import { scheduleGroupTurn, scheduleReply } from '../reply/planner.ts';
import { getRelationship } from '../relationship/service.ts';
import { mediaUrl } from '../services/avatars.ts';
import { messageToDto, postMessage } from '../services/messages.ts';
import { readUpload } from './uploads.ts';

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
          members: mem.map((m) => ({ avatarId: m.avatarId, seenUpTo: m.seenUpTo?.toISOString() ?? null })),
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
    const { content, image } = parseBody(sendMessageSchema, req.body);
    const conv = await assertConversation(id);
    const upload = image ? await readUpload(app.deps.mediaDir, image) : null;
    const dto = await postMessage(db, events, {
      conversationId: id,
      senderType: 'user',
      content,
      meta: upload ? { image: { path: upload.path, mime: upload.mime, width: upload.width, height: upload.height } } : undefined,
    });
    // 一對一：依 avatar 的作息決定什麼時候看到；群組：等玩家講完再開始一輪
    if (conv.type === 'group') await scheduleGroupTurn(db, jobs, id);
    else await scheduleReply(db, jobs, id);
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
    const conv = await assertConversation(id);
    await jobs.add(
      conv.type === 'group' ? { kind: 'group.turn', conversationId: id, force: true } : { kind: 'reply', conversationId: id, force: true },
    );
    return reply.status(202).send();
  });

  async function assertConversation(id: string) {
    const [c] = await db.select().from(conversations).where(eq(conversations.id, id));
    if (!c) throw notFound('對話');
    return c;
  }

  async function assertGroup(id: string) {
    const c = await assertConversation(id);
    if (c.type !== 'group') throw new HttpError(400, '這不是群組');
    return c;
  }

  async function assertAvatars(ids: string[]) {
    const rows = await db.select({ id: avatars.id }).from(avatars).where(inArray(avatars.id, ids));
    if (rows.length !== new Set(ids).size) throw new HttpError(400, '有不存在的 avatar');
  }

  /**
   * 同一個群組的 avatar 之間建立關係：設成相關角色的已經有了；原本不認識的從陌生開始，
   * 之後在群組裡一起聊天會慢慢變熟（growFamiliarity）。
   */
  async function ensurePairs(ids: string[]) {
    for (const a of ids) for (const b of ids) if (a !== b) await getRelationship(db, a, `avatar:${b}`, 'stranger');
  }

  app.post('/conversations', async (req, reply) => {
    const { title, avatarIds } = parseBody(groupInputSchema, req.body);
    await assertAvatars(avatarIds);
    const conv = await db.transaction(async (tx) => {
      const [c] = await tx.insert(conversations).values({ type: 'group', title }).returning();
      await tx.insert(conversationMembers).values([...new Set(avatarIds)].map((avatarId) => ({ conversationId: c!.id, avatarId })));
      return c!;
    });
    await ensurePairs(avatarIds);
    await events.publish({ type: 'conversations.changed' });
    return reply.status(201).send({ id: conv.id });
  });

  app.put('/conversations/:id', async (req) => {
    const { id } = parseBody(idParams, req.params);
    const { title, avatarIds } = parseBody(groupInputSchema, req.body);
    await assertGroup(id);
    await assertAvatars(avatarIds);
    const wanted = new Set(avatarIds);
    const current = await db.select().from(conversationMembers).where(eq(conversationMembers.conversationId, id));
    await db.transaction(async (tx) => {
      await tx.update(conversations).set({ title, updatedAt: new Date() }).where(eq(conversations.id, id));
      const removed = current.filter((m) => !wanted.has(m.avatarId)).map((m) => m.avatarId);
      if (removed.length) {
        await tx
          .delete(conversationMembers)
          .where(and(eq(conversationMembers.conversationId, id), inArray(conversationMembers.avatarId, removed)));
      }
      const added = [...wanted].filter((a) => !current.some((m) => m.avatarId === a));
      // 新加入的成員從現在開始參與，之前的訊息不算它「沒讀」
      if (added.length) {
        await tx.insert(conversationMembers).values(added.map((avatarId) => ({ conversationId: id, avatarId, seenUpTo: new Date() })));
      }
    });
    await ensurePairs(avatarIds);
    await events.publish({ type: 'conversations.changed' });
    return { ok: true };
  });

  app.delete('/conversations/:id', async (req, reply) => {
    const { id } = parseBody(idParams, req.params);
    await assertGroup(id);
    await db.delete(conversations).where(eq(conversations.id, id));
    await events.publish({ type: 'conversations.changed' });
    return reply.status(204).send();
  });

  /** 群組：玩家正在打字（前端每幾秒送一次），這一輪會等玩家打完 */
  app.post('/conversations/:id/typing', async (req, reply) => {
    const { id } = parseBody(idParams, req.params);
    await db
      .update(conversations)
      .set({ userTypingAt: new Date() })
      .where(and(eq(conversations.id, id), eq(conversations.type, 'group')));
    return reply.status(204).send();
  });
}
