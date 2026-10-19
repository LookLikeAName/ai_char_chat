import { availabilityAt, isPersonaEmpty, missingFields, type AvatarDto } from '@acc/shared';
import type { avatars } from '../db/schema.ts';

export function mediaUrl(p: string | null): string | null {
  return p ? `/media/${p}` : null;
}

export function avatarToDto(
  row: typeof avatars.$inferSelect,
  dmConversationId: string,
  timezone: string,
  now = new Date(),
): AvatarDto {
  const a = availabilityAt(row.persona, now, timezone);
  return {
    id: row.id,
    name: row.name,
    bio: row.bio,
    imageUrl: mediaUrl(row.imagePath),
    llm: row.llm ?? null,
    persona: row.persona,
    personaLocks: row.personaLocks,
    personaComplete: !isPersonaEmpty(row.persona) && missingFields(row.persona).length === 0,
    availability: { status: a.status, activity: a.activity, until: a.until?.toISOString() ?? null },
    dmConversationId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
