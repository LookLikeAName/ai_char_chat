import type { AvatarDto } from '@acc/shared';
import type { avatars } from '../db/schema.ts';

export function mediaUrl(p: string | null): string | null {
  return p ? `/media/${p}` : null;
}

export function avatarToDto(row: typeof avatars.$inferSelect, dmConversationId: string): AvatarDto {
  return {
    id: row.id,
    name: row.name,
    bio: row.bio,
    imageUrl: mediaUrl(row.imagePath),
    llm: row.llm ?? null,
    dmConversationId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
