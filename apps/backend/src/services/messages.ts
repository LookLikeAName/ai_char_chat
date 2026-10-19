import { eq, sql } from 'drizzle-orm';
import type { MessageDto } from '@acc/shared';
import type { Db } from '../db/client.ts';
import { conversations, messages, type MessageMeta } from '../db/schema.ts';
import type { EventPublisher } from '../events/bus.ts';

type MessageRow = typeof messages.$inferSelect;

export function messageToDto(m: MessageRow): MessageDto {
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderType: m.senderType,
    senderAvatarId: m.senderAvatarId,
    content: m.content,
    createdAt: m.createdAt.toISOString(),
    innerThought: m.meta.innerThought ?? null,
    systemKind: m.meta.systemKind ?? null,
  };
}

/** 寫入一則訊息、更新對話的最後訊息時間，並推播給瀏覽器 */
export async function postMessage(
  db: Db,
  events: EventPublisher,
  values: {
    conversationId: string;
    senderType: MessageRow['senderType'];
    senderAvatarId?: string | null;
    content: string;
    meta?: MessageMeta;
  },
): Promise<MessageDto> {
  const row = await db.transaction(async (tx) => {
    const [m] = await tx
      .insert(messages)
      .values({
        conversationId: values.conversationId,
        senderType: values.senderType,
        senderAvatarId: values.senderAvatarId ?? null,
        content: values.content,
        meta: values.meta ?? {},
      })
      .returning();
    await tx.update(conversations).set({ lastMessageAt: sql`now()` }).where(eq(conversations.id, values.conversationId));
    return m!;
  });
  const dto = messageToDto(row);
  await events.publish({ type: 'message.created', message: dto });
  return dto;
}
