import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { sendMessageSchema, type ConversationDto, type MessageDto } from '@acc/shared';
import { avatars, conversationMembers, conversations, messages } from '../db/schema.ts';
import { notFound, parseBody } from '../errors.ts';
import { mediaUrl } from '../services/avatars.ts';

const idParams = z.object({ id: z.uuid() });
const pageQuery = z.object({
  before: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

type MessageRow = typeof messages.$inferSelect;

export function messageToDto(m: MessageRow): MessageDto {
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderType: m.senderType,
    senderAvatarId: m.senderAvatarId,
    content: m.content,
    createdAt: m.createdAt.toISOString(),
  };
}

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
      })
      .from(conversationMembers)
      .innerJoin(avatars, eq(avatars.id, conversationMembers.avatarId))
      .where(inArray(conversationMembers.conversationId, ids));
    // 每個對話的最後一則訊息
    const last = await db
      .selectDistinctOn([messages.conversationId])
      .from(messages)
      .where(inArray(messages.conversationId, ids))
      .orderBy(messages.conversationId, desc(messages.createdAt));
    const lastBy = new Map(last.map((m) => [m.conversationId, m]));

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
      .orderBy(desc(messages.createdAt))
      .limit(limit);
    return { messages: rows.reverse().map(messageToDto), hasMore: rows.length === limit };
  });

  app.post('/conversations/:id/messages', async (req, reply) => {
    const { id } = parseBody(idParams, req.params);
    const { content } = parseBody(sendMessageSchema, req.body);
    await assertConversation(id);
    const row = await db.transaction(async (tx) => {
      const [m] = await tx.insert(messages).values({ conversationId: id, senderType: 'user', content }).returning();
      await tx.update(conversations).set({ lastMessageAt: sql`now()` }).where(eq(conversations.id, id));
      return m!;
    });
    const dto = messageToDto(row);
    await events.publish({ type: 'message.created', message: dto });
    await jobs.add({ kind: 'user-message', conversationId: id, messageId: row.id });
    return reply.status(201).send(dto);
  });

  async function assertConversation(id: string) {
    const [c] = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, id));
    if (!c) throw notFound('對話');
  }
}
