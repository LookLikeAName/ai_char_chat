// 透過綁定呼叫 LLM：先檢查每日上限；用量記進 usage_log，完整的 context 記進 llm_traces（監控頁），失敗也記。
import { costUsd, type LlmBinding } from '@acc/shared';
import type { SecretBox } from '../crypto.ts';
import type { Db } from '../db/client.ts';
import { usageLog } from '../db/schema.ts';
import { loggedContent } from '../llm/content.ts';
import { complete, type ChatRequest, type ChatResult, type FetchFn } from '../llm/index.ts';
import { recordTrace } from '../observability.ts';
import { resolveBinding } from './llmProfiles.ts';
import { checkQuota } from './usage.ts';

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
): Promise<ChatResult & { traceId: string | null }> {
  await checkQuota(ctx.db, usage.purpose, usage.avatarId);
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
        costUsd: costUsd(profile.pricing, res?.usage.inputTokens ?? 0, res?.usage.outputTokens ?? 0),
        ok,
        error: error?.slice(0, 500) ?? null,
      })
      .catch(() => {});
  const trace = (ok: boolean, res?: ChatResult, error?: string) =>
    recordTrace({
      purpose: usage.purpose,
      avatarId: usage.avatarId,
      provider: profile.provider,
      model: profile.model,
      params: params as Record<string, unknown>,
      request: { system: req.system, messages: req.messages.map((m) => ({ role: m.role, content: loggedContent(m.content) })), json: req.json },
      response: res?.text ?? null,
      inputTokens: res?.usage.inputTokens ?? 0,
      outputTokens: res?.usage.outputTokens ?? 0,
      latencyMs: Date.now() - started,
      ok,
      error: error?.slice(0, 1000) ?? null,
    });
  try {
    const res = await complete(llm, { ...req, params }, ctx.fetchFn);
    await log(true, res);
    return { ...res, traceId: await trace(true, res) };
  } catch (err) {
    await log(false, undefined, (err as Error).message);
    await trace(false, undefined, (err as Error).message);
    throw err;
  }
}
