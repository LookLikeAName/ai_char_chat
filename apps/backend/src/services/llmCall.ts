// 透過綁定呼叫 LLM：先檢查每日上限；用量記進 usage_log，完整的 context 記進 llm_traces（監控頁），失敗也記。
// 設定檔有備援時，被拒絕或呼叫失敗就改用備援的設定檔（例如雲端被擋就轉到地端），每次嘗試都各自記錄。
import { costUsd, defaultVision, type LlmBinding } from '@acc/shared';
import type { SecretBox } from '../crypto.ts';
import type { Db } from '../db/client.ts';
import { usageLog } from '../db/schema.ts';
import { loggedContent, partsOf } from '../llm/content.ts';
import { complete, LlmError, type ChatRequest, type ChatResult, type FetchFn } from '../llm/index.ts';
import { logEvent, recordTrace } from '../observability.ts';
import { resolveBinding } from './llmProfiles.ts';
import { checkQuota } from './usage.ts';

export interface CallContext {
  db: Db;
  box: SecretBox;
  fetchFn?: FetchFn;
}

/** 因為內容被擋下的結束原因（各家供應商） */
const BLOCKED_FINISH = ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'content_filter', 'refusal'];
/** 錯誤訊息看得出是被安全過濾擋下 */
const BLOCKED_ERROR = /被擋下|safety|content[_ ]?(policy|filter|management)|moderation|prohibited/i;
/** 要求 JSON 卻回了一段拒答（不是角色在拒絕，而是模型本身） */
const REFUSAL_TEXT =
  /(I can['’]?t|I cannot|I['’]?m sorry|I am sorry|I am unable|I['’]?m unable|as an AI|抱歉[，,]?\s*我(無法|不能|沒辦法)|我(無法|不能)(提供|協助|產生|撰寫|回應|繼續)|作為(一個)?\s*AI)/i;

/** 這次的回應是不是被拒絕了；是的話回傳原因 */
export function refusalOf(res: ChatResult, wantJson: boolean): string | null {
  const text = res.text.trim();
  if (res.finishReason && BLOCKED_FINISH.includes(res.finishReason) && text.length < 20) return `結束原因：${res.finishReason}`;
  if (wantJson && !text.includes('{') && REFUSAL_TEXT.test(text.slice(0, 300))) return `模型拒答：${text.slice(0, 80)}`;
  return null;
}

/** 錯誤屬於哪一種：被安全過濾擋下算「被拒絕」，其他算「呼叫失敗」 */
function errorKind(err: unknown): 'refusal' | 'error' | null {
  if (!(err instanceof LlmError)) return null;
  return BLOCKED_ERROR.test(err.message) ? 'refusal' : 'error';
}

type CallResult = ChatResult & { traceId: string | null; profileId: string; model: string; fellBack: boolean };

export async function callWithBinding(
  ctx: CallContext,
  binding: LlmBinding,
  req: Omit<ChatRequest, 'params'>,
  /** fallback: false 時不改用備援（例如成人內容測試要測的就是這個模型本身） */
  usage: { purpose: string; avatarId?: string | null; fallback?: boolean },
): Promise<CallResult> {
  await checkQuota(ctx.db, usage.purpose, usage.avatarId);
  const tried = new Set<string>();
  let current = binding;
  for (;;) {
    tried.add(current.profileId);
    const { profile, attempt } = await callOnce(ctx, current, req, usage);
    const fb = usage.fallback === false ? null : profile.fallback;
    const next = fb && !tried.has(fb.profileId) ? fb : null;
    let reason: string | null = null;
    if (attempt.ok) {
      const refused = refusalOf(attempt.res, !!req.json);
      if (!refused || !next?.onRefusal) {
        return { ...attempt.res, traceId: attempt.traceId, profileId: profile.id, model: profile.model, fellBack: tried.size > 1 };
      }
      reason = `被拒絕（${refused}）`;
    } else {
      const kind = errorKind(attempt.error);
      if (!next || !kind || (kind === 'refusal' ? !next.onRefusal : !next.onError)) throw attempt.error;
      reason = `${kind === 'refusal' ? '被拒絕' : '呼叫失敗'}（${(attempt.error as Error).message.slice(0, 120)}）`;
    }
    await logEvent({
      category: 'llm',
      type: 'llm.fallback',
      level: 'warn',
      avatarId: usage.avatarId ?? null,
      traceId: attempt.traceId,
      message: `「${profile.name}」${reason}，改用備援設定檔`,
      data: { purpose: usage.purpose, from: profile.id, to: next.profileId },
    });
    // 覆寫的參數照用（例如溫度、輸出上限）；思考程度只有 Gemini 有，換供應商時不帶
    const { thinking: _thinking, ...params } = current.params ?? {};
    current = { profileId: next.profileId, params };
  }
}

function withoutImages(m: ChatRequest['messages'][number]): ChatRequest['messages'][number] {
  if (typeof m.content === 'string' || !m.content.some((p) => p.type === 'image')) return m;
  const text = partsOf(m.content)
    .map((p) => (p.type === 'text' ? p.text : '［圖片］'))
    .join('\n');
  return { ...m, content: text };
}

/** 呼叫一次（一個設定檔），記錄用量與 trace；失敗時不拋出，交給上層決定要不要改用備援 */
async function callOnce(ctx: CallContext, binding: LlmBinding, req: Omit<ChatRequest, 'params'>, usage: { purpose: string; avatarId?: string | null }) {
  const { llm, params, profile } = await resolveBinding(ctx.db, ctx.box, binding);
  // 看不懂圖片的模型（例如改用的地端備援）：圖片換成文字標記，免得整個請求失敗
  if (!(profile.vision ?? defaultVision(profile.provider))) req = { ...req, messages: req.messages.map(withoutImages) };
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
    return { profile, attempt: { ok: true as const, res, traceId: await trace(true, res) } };
  } catch (err) {
    await log(false, undefined, (err as Error).message);
    return { profile, attempt: { ok: false as const, error: err, traceId: await trace(false, undefined, (err as Error).message) } };
  }
}
