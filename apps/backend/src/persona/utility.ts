// 系統工具模型的呼叫（補完設定、一致性檢查…）
import type { AppSettings } from '@acc/shared';
import { HttpError } from '../errors.ts';
import { LlmError, type ChatMessage } from '../llm/index.ts';
import { callWithBinding, type CallContext } from '../services/llmCall.ts';

/** 產生整份角色設定的輸出很長，輸出上限至少要這麼多 */
const MIN_OUTPUT_TOKENS = 8192;

export async function callUtility(
  ctx: CallContext,
  settings: AppSettings,
  req: { system: string; messages: ChatMessage[] },
  purpose: string,
): Promise<string> {
  const binding = settings.utilityLlm;
  if (!binding) throw new HttpError(400, '請先到「設定 → 一般」選擇系統工具模型');
  const params = { ...binding.params };
  if (params.maxOutputTokens !== undefined && params.maxOutputTokens < MIN_OUTPUT_TOKENS) {
    params.maxOutputTokens = MIN_OUTPUT_TOKENS;
  }
  try {
    const res = await callWithBinding(
      ctx,
      { ...binding, params: { maxOutputTokens: MIN_OUTPUT_TOKENS, ...params } },
      { ...req, json: true, timeoutMs: 180_000 },
      { purpose },
    );
    return res.text;
  } catch (err) {
    if (err instanceof LlmError) throw new HttpError(502, `系統工具模型呼叫失敗：${err.message}`);
    throw err;
  }
}

export function parseJsonObject(text: string): Record<string, unknown> | null {
  const stripped = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(stripped.slice(start, end + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
