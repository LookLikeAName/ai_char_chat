// 相關的角色（例如同一間公司的同事）：存成無方向的一對，關係描述雙方共用。
// 用在三個地方：產生／檢查人格設定時當參考、聊天時讓 avatar 知道自己認識誰、群組成員列表。
import { eq, inArray, or } from 'drizzle-orm';
import { STAGE_LABELS, visibleStage, type AvatarLink, type InitialStage, type PersonaDraft } from '@acc/shared';
import type { Db } from '../db/client.ts';
import { avatarLinks, avatars } from '../db/schema.ts';
import { HttpError } from '../errors.ts';
import { resetRelationship } from '../relationship/service.ts';

const pair = (x: string, y: string) => (x < y ? { aId: x, bId: y } : { aId: y, bId: x });

/** 每個 avatar 的相關角色（兩邊都列出來） */
export async function loadLinks(db: Db, avatarIds?: string[]): Promise<Map<string, AvatarLink[]>> {
  const rows = await db
    .select()
    .from(avatarLinks)
    .where(avatarIds ? or(inArray(avatarLinks.aId, avatarIds), inArray(avatarLinks.bId, avatarIds)) : undefined);
  const out = new Map<string, AvatarLink[]>();
  const push = (id: string, link: AvatarLink) => out.set(id, [...(out.get(id) ?? []), link]);
  for (const r of rows) {
    push(r.aId, { avatarId: r.bId, relation: r.relation, stage: r.stage });
    push(r.bId, { avatarId: r.aId, relation: r.relation, stage: r.stage });
  }
  return out;
}

/** 相關的角色都要是已經存在的 avatar（建立前先檢查，免得建到一半才失敗） */
export async function assertLinkTargets(db: Db, links: AvatarLink[]): Promise<void> {
  const ids = [...new Set(links.map((l) => l.avatarId))];
  if (!ids.length) return;
  const found = await db.select({ id: avatars.id }).from(avatars).where(inArray(avatars.id, ids));
  if (found.length !== ids.length) throw new HttpError(400, '相關的角色裡有不存在的 avatar');
}

/**
 * 整份取代這個 avatar 的相關角色。新的關聯、或改了一開始的關係時，
 * 兩個 avatar 之間（雙向）的關係重設成那個階段；只改描述不會動到已經累積的好感。
 */
export async function saveLinks(db: Db, avatarId: string, links: AvatarLink[]): Promise<void> {
  const wanted = new Map(
    links.filter((l) => l.avatarId !== avatarId).map((l) => [l.avatarId, { relation: l.relation, stage: l.stage ?? 'acquaintance' }]),
  );
  await assertLinkTargets(db, [...wanted.keys()].map((id) => ({ avatarId: id, relation: '', stage: 'acquaintance' })));
  const before = (await loadLinks(db, [avatarId])).get(avatarId) ?? [];
  await db.transaction(async (tx) => {
    await tx.delete(avatarLinks).where(or(eq(avatarLinks.aId, avatarId), eq(avatarLinks.bId, avatarId)));
    if (wanted.size) {
      await tx.insert(avatarLinks).values([...wanted].map(([other, l]) => ({ ...pair(avatarId, other), ...l })));
    }
  });
  for (const [other, { stage }] of wanted) {
    if (before.find((b) => b.avatarId === other)?.stage === stage) continue;
    await resetRelationship(db, avatarId, stage, `avatar:${other}`);
    await resetRelationship(db, other, stage, `avatar:${avatarId}`);
  }
}

export interface LinkedAvatar {
  id: string;
  name: string;
  displayName: string;
  bio: string;
  persona: PersonaDraft;
  relation: string;
  stage: InitialStage;
}

export async function linkedAvatars(db: Db, links: AvatarLink[]): Promise<LinkedAvatar[]> {
  if (!links.length) return [];
  const rows = await db
    .select({ id: avatars.id, name: avatars.name, displayName: avatars.displayName, bio: avatars.bio, persona: avatars.persona })
    .from(avatars)
    .where(inArray(avatars.id, links.map((l) => l.avatarId)));
  return links.flatMap((l) => {
    const a = rows.find((r) => r.id === l.avatarId);
    return a ? [{ ...a, relation: l.relation, stage: l.stage }] : [];
  });
}

/** 一個角色的重點：年齡、職業、住哪、家人、個性、說話方式、作息、和玩家的關係 */
export function describeLinked(a: LinkedAvatar, detail: 'brief' | 'full', adultContent = true): string {
  const p = a.persona;
  const b = p.basic ?? {};
  const head = [b.age ? `${b.age} 歲` : '', b.gender ?? '', b.occupation ?? ''].filter(Boolean).join('、');
  const lines = [
    `### ${a.name}${head ? `（${head}）` : ''}`,
    a.displayName && a.displayName !== a.name ? `通訊軟體上的顯示名稱：${a.displayName}` : '',     `你們的關係：${a.relation}（${STAGE_LABELS[visibleStage(a.stage, adultContent)]}）`,
    a.bio ? `簡介：${a.bio}` : '',
  ];
  if (detail === 'full') {
    const day = p.routine?.schedule?.weekday?.map((s) => `${s.start}–${s.end} ${s.activity}`).join('；');
    lines.push(
      b.location ? `住在：${b.location}` : '',
      b.family ? `家人：${b.family}` : '',
      b.appearance ? `外貌：${b.appearance}` : '',
      p.personality?.traits?.length ? `個性：${p.personality.traits.join('、')}` : '',
      p.speech?.tone ? `說話：${p.speech.tone}` : '',
      b.lifeEvents?.length ? `經歷：${b.lifeEvents.join('；')}` : '',
      day ? `平日作息：${day}` : '',
      p.relationship?.withUser ? `他和玩家的關係（「對方」指玩家）：${p.relationship.withUser}` : '',
    );
  } else {
    lines.push(p.personality?.traits?.length ? `個性：${p.personality.traits.join('、')}` : '');
  }
  return lines.filter(Boolean).join('\n');
}

/** 產生、檢查人格設定時附上的參考角色段落 */
export async function referenceSection(db: Db, refs: AvatarLink[], adultContent = true): Promise<string> {
  const list = await linkedAvatars(db, refs);
  if (!list.length) return '';
  return `# 相關的角色（已經存在，新的設定要和他們一致）
${list.map((a) => describeLinked(a, 'full', adultContent)).join('\n\n')}`;
}
