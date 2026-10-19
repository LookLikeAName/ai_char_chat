import { joinContent } from './content.ts';
import { LlmError, type ChatMessage, type ChatRequest, type FetchFn } from './types.ts';

const DEFAULT_TIMEOUT_MS = 90_000;

export function requestSignal(req: Pick<ChatRequest, 'signal' | 'timeoutMs'>): AbortSignal {
  const timeout = AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
}

export async function requestJson<T>(
  fetchFn: FetchFn,
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: unknown; signal?: AbortSignal },
): Promise<T> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: init.body === undefined ? init.headers : { 'content-type': 'application/json', ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    const e = err as Error;
    if (e.name === 'TimeoutError') throw new LlmError('連線逾時');
    if (e.name === 'AbortError') throw e;
    // fetch failed 本身沒什麼資訊，真正的原因（ENOTFOUND、ECONNREFUSED…）在 cause 裡
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code ?? cause?.message;
    throw new LlmError(`無法連線：${e.message}${detail ? `（${detail}）` : ''}`);
  }
  const text = await res.text();
  if (!res.ok) throw new LlmError(`供應商回應 ${res.status}：${errorMessage(text)}`, res.status);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new LlmError(`供應商回傳的不是 JSON：${text.slice(0, 200)}`, res.status);
  }
}

function errorMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    const msg = typeof j.error === 'string' ? j.error : (j.error?.message ?? j.message);
    if (msg) return msg.slice(0, 500);
  } catch {
    // 不是 JSON，直接截斷原文
  }
  return body.slice(0, 500) || '(沒有內容)';
}

/**
 * 合併連續同角色的訊息，並確保第一則是 user。
 * Anthropic 與 Gemini 都要求 user / assistant 交替；群組聊天時其他 avatar 的發言會被併進 user 角色。
 */
export function alternate(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content = joinContent(last.content, m.content);
    else out.push({ ...m });
  }
  if (out[0]?.role !== 'user') out.unshift({ role: 'user', content: '（對話開始）' });
  return out;
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
