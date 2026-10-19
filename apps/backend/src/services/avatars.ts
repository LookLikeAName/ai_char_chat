import {
  availabilityAt,
  avatarPhotoSchema,
  DEFAULT_AVATAR_PHOTO,
  type AvatarLink,
  type AvatarPhoto,
  fieldMeta,
  isPersonaEmpty,
  missingFields,
  sanitizeDraft,
  type AvatarDto,
  type PersonaDraft,
} from '@acc/shared';
import type { avatars } from '../db/schema.ts';
import { HttpError } from '../errors.ts';

export function mediaUrl(p: string | null): string | null {
  return p ? `/media/${p}` : null;
}

/** 存的是部分欄位（舊資料是空物件），補上預設值 */
export function avatarPhoto(row: Pick<typeof avatars.$inferSelect, 'photo'>): AvatarPhoto {
  const r = avatarPhotoSchema.safeParse(row.photo ?? {});
  return r.success ? r.data : DEFAULT_AVATAR_PHOTO;
}

export function avatarToDto(
  row: typeof avatars.$inferSelect,
  dmConversationId: string,
  timezone: string,
  links: AvatarLink[] = [],
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
    dailyTokenLimit: row.dailyTokenLimit,
    photo: avatarPhoto(row),
    links,
    photoReferenceUrl: mediaUrl(row.photoReferencePath),
    availability: { status: a.status, activity: a.activity, until: a.until?.toISOString() ?? null },
    dmConversationId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * 人格設定要嘛全空（只靠簡介），要嘛全部填滿；有不合法的值或缺欄位就拒絕。
 * undefined 表示不變更。
 */
export function validatePersona(input: Record<string, unknown> | undefined): PersonaDraft | undefined {
  if (input === undefined) return undefined;
  const { draft, errors } = sanitizeDraft(input);
  const bad = Object.entries(errors)[0];
  if (bad) throw new HttpError(400, `${fieldMeta(bad[0])?.label ?? bad[0]}：${bad[1]}`);
  if (isPersonaEmpty(draft)) return {};
  const missing = missingFields(draft);
  if (missing.length) {
    const names = missing.slice(0, 5).map((p) => fieldMeta(p)?.label ?? p);
    throw new HttpError(
      400,
      `人格設定還有 ${missing.length} 個欄位沒填（${names.join('、')}${missing.length > 5 ? '…' : ''}），可以用「AI 補完」填滿`,
    );
  }
  return draft;
}
