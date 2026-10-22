import { eq, sql } from 'drizzle-orm';
import type { MessageDto } from '@acc/shared';
import type { Db } from '../db/client.ts';
import { conversations, messages, type MessageMeta } from '../db/schema.ts';
import type { EventPublisher } from '../events/bus.ts';
import { mediaUrl } from './avatars.ts';

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
    traceId: m.meta.traceId ?? null,
    proactive: !!m.meta.proactive,
    image: m.meta.image
      ? {
          url: mediaUrl(m.meta.image.path)!,
          width: m.meta.image.width,
          height: m.meta.image.height,
          description: m.meta.image.description ?? null,
        }
      : null,
    narration: m.meta.narration ?? null,
    meetupId: m.meta.meetupId ?? null,
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
    /** 補上停機期間的訊息時用過去的時間；平常省略（用現在） */
    createdAt?: Date;
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
        ...(values.createdAt ? { createdAt: values.createdAt } : {}),
      })
      .returning();
    await tx
      .update(conversations)
      .set({ lastMessageAt: values.createdAt ? sql`greatest(${conversations.lastMessageAt}, ${values.createdAt})` : sql`now()` })
      .where(eq(conversations.id, values.conversationId));
    return m!;
  });
  const dto = messageToDto(row);
  await events.publish({ type: 'message.created', message: dto });
  return dto;
}
