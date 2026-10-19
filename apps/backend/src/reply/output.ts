// 解析 avatar 回覆的 JSON。模型偶爾會包 ```json、前後多講話，盡量救回來。
import { z } from 'zod';

export interface ReplyOutput {
  innerThought: string;
  messages: string[];
}

const MAX_MESSAGES = 6;
const MAX_MESSAGE_CHARS = 1500;

const outputSchema = z.object({
  inner_thought: z.string().optional(),
  messages: z.union([z.array(z.string()), z.string()]).optional(),
  message: z.string().optional(),
});

function extractJson(text: string): unknown {
  const stripped = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function clean(messages: string[]): string[] {
  return messages
    .map((m) => m.trim())
    .filter(Boolean)
    .slice(0, MAX_MESSAGES)
    .map((m) => (m.length > MAX_MESSAGE_CHARS ? `${m.slice(0, MAX_MESSAGE_CHARS)}…` : m));
}

/** 解析失敗時回傳 null */
export function parseReplyOutput(text: string): ReplyOutput | null {
  const parsed = outputSchema.safeParse(extractJson(text));
  if (!parsed.success) return null;
  const raw = parsed.data.messages ?? parsed.data.message;
  const messages = clean(typeof raw === 'string' ? [raw] : (raw ?? []));
  if (!messages.length) return null;
  return { innerThought: parsed.data.inner_thought?.trim() ?? '', messages };
}

/**
 * 最後手段：模型完全沒照格式、直接回了一段話時，當成純文字訊息。
 * 看起來像壞掉的 JSON 就放棄，避免把 `{"messages": [` 這種東西送給玩家。
 */
export function plainTextFallback(text: string): ReplyOutput | null {
  const t = text.trim();
  if (!t || /[{}[\]]/.test(t.slice(0, 2)) || /"messages"\s*:/.test(t)) return null;
  const messages = clean(t.split(/\n\s*\n/));
  return messages.length ? { innerThought: '', messages } : null;
}
