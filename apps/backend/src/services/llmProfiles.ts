import { eq } from 'drizzle-orm';
import {
  defaultVision,
  PROFILE_KIND_LABELS,
  type ProfileKind,
  effectiveBaseUrl,
  resolveParams,
  type LlmBinding,
  type LlmParams,
  type LlmProfileDto,
  type LlmProfileInput,
} from '@acc/shared';
import type { SecretBox } from '../crypto.ts';
import type { Db } from '../db/client.ts';
import { avatars, llmProfiles } from '../db/schema.ts';
import { HttpError, notFound } from '../errors.ts';
import type { ResolvedLlm } from '../llm/index.ts';

type ProfileRow = typeof llmProfiles.$inferSelect;

export function profileToDto(row: ProfileRow, usedBy: number): LlmProfileDto {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    baseUrl: row.baseUrl,
    model: row.model,
    hasApiKey: !!row.apiKeyEnc,
    apiKeyHint: row.apiKeyHint,
    defaults: row.defaults,
    kind: row.kind,
    pricing: row.pricing ?? null,
    vision: row.vision ?? defaultVision(row.provider),
    visionSet: row.vision !== null,
    usedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 每個設定檔被幾個 avatar 綁定 */
export async function profileUsage(db: Db): Promise<Map<string, number>> {
  const rows = await db.select({ llm: avatars.llm }).from(avatars);
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r.llm) counts.set(r.llm.profileId, (counts.get(r.llm.profileId) ?? 0) + 1);
  }
  return counts;
}

export async function getProfile(db: Db, id: string): Promise<ProfileRow> {
  const [row] = await db.select().from(llmProfiles).where(eq(llmProfiles.id, id));
  if (!row) throw notFound('LLM 設定檔');
  return row;
}

/** 確認設定檔存在；給了 kind 時也要是這個用途（例如 avatar 的大腦只能選聊天用的） */
export async function assertProfileExists(db: Db, id: string, kind?: ProfileKind): Promise<void> {
  const p = await getProfile(db, id);
  if (kind && p.kind !== kind) {
    throw new HttpError(400, `「${p.name}」是${PROFILE_KIND_LABELS[p.kind]}用的設定檔，這裡要選${PROFILE_KIND_LABELS[kind]}用的`);
  }
}

export function resolveRow(row: ProfileRow, box: SecretBox): ResolvedLlm {
  return toResolved(
    { provider: row.provider, baseUrl: row.baseUrl, model: row.model },
    row.apiKeyEnc ? box.decrypt(row.apiKeyEnc) : undefined,
  );
}

export function toResolved(
  p: Pick<LlmProfileInput, 'provider' | 'baseUrl' | 'model'>,
  apiKey: string | undefined,
): ResolvedLlm {
  const baseUrl = effectiveBaseUrl(p.provider, p.baseUrl);
  if (!baseUrl) throw new HttpError(400, '這個供應商必須填寫 Base URL');
  return { provider: p.provider, baseUrl, model: p.model, apiKey };
}

/** 綁定 → 可以呼叫的 LLM 與實際參數 */
export async function resolveBinding(
  db: Db,
  box: SecretBox,
  binding: LlmBinding,
): Promise<{ llm: ResolvedLlm; params: LlmParams; profile: ProfileRow }> {
  const profile = await getProfile(db, binding.profileId);
  return { llm: resolveRow(profile, box), params: resolveParams(profile.defaults, binding.params), profile };
}
