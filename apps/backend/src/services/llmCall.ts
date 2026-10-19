// 透過綁定呼叫 LLM，並把用量記進 usage_log（失敗也記）。
import type { LlmBinding } from '@acc/shared';
import type { SecretBox } from '../crypto.ts';
import type { Db } from '../db/client.ts';
import { usageLog } from '../db/schema.ts';
import { complete, type ChatRequest, type ChatResult, type FetchFn } from '../llm/index.ts';
import { resolveBinding } from './llmProfiles.ts';

export interface CallContext {
  db: Db;
  box: SecretBox;
  fetchFn?: FetchFn;
}

export async function callWithBinding(
  ctx: CallContext,
  binding: LlmBinding,
  req: Omit<ChatRequest, 'params'>,
  usage: { purpose: string; avatarId?: string | null },
): Promise<ChatResult> {
  const { llm, params, profile } = await resolveBinding(ctx.db, ctx.box, binding);
  const started = Date.now();
  const log = (ok: boolean, res?: ChatResult, error?: string) =>
    ctx.db
      .insert(usageLog)
      .values({
        purpose: usage.purpose,
        avatarId: usage.avatarId ?? null,
        profileId: profile.id,
        model: profile.model,
        inputTokens: res?.usage.inputTokens ?? 0,
        outputTokens: res?.usage.outputTokens ?? 0,
        latencyMs: Date.now() - started,
        ok,
        error: error?.slice(0, 500) ?? null,
      })
      .catch(() => {});
  try {
    const res = await complete(llm, { ...req, params }, ctx.fetchFn);
    await log(true, res);
    return res;
  } catch (err) {
    await log(false, undefined, (err as Error).message);
    throw err;
  }
}
