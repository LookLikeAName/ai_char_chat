// 解析 avatar 回覆的 JSON。模型偶爾會包 ```json、前後多講話，盡量救回來。
import { z } from 'zod';
import { moodSchema, RELATIONSHIP_EVENTS, type Mood, type RelationshipEventType } from '@acc/shared';

export interface ReplyOutput {
  innerThought: string;
  messages: string[];
  /** 回覆後的心情；模型沒給就不變 */
  mood?: Mood;
  affinityDelta: number;
  trustDelta: number;
  event: { type: RelationshipEventType; note: string } | null;
}

const MAX_MESSAGES = 6;
const MAX_MESSAGE_CHARS = 1500;

const outputSchema = z.object({
  inner_thought: z.string().optional(),
  messages: z.union([z.array(z.string()), z.string()]).optional(),
  message: z.string().optional(),
  // 狀態欄位格式不對時當作沒給，不影響訊息本身
  mood: z.unknown().optional(),
  affinity_delta: z.unknown().optional(),
  trust_delta: z.unknown().optional(),
  relationship_event: z.unknown().optional(),
});

function delta(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function parseEvent(v: unknown): ReplyOutput['event'] {
  if (!v) return null;
  const type = typeof v === 'string' ? v : (v as { type?: unknown }).type;
  if (typeof type !== 'string' || !(RELATIONSHIP_EVENTS as readonly string[]).includes(type)) return null;
  const note = typeof v === 'object' && typeof (v as { note?: unknown }).note === 'string' ? (v as { note: string }).note : '';
  return { type: type as RelationshipEventType, note: note.slice(0, 200) };
}

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

/** 解析失敗時回傳 null；allowEmpty 時（主動發話）明確給了空的 messages 也算成功 */
export function parseReplyOutput(text: string, opts: { allowEmpty?: boolean } = {}): ReplyOutput | null {
  const parsed = outputSchema.safeParse(extractJson(text));
  if (!parsed.success) return null;
  const raw = parsed.data.messages ?? parsed.data.message;
  const messages = clean(typeof raw === 'string' ? [raw] : (raw ?? []));
  if (!messages.length && !(opts.allowEmpty && Array.isArray(raw))) return null;
  const mood = moodSchema.safeParse(parsed.data.mood);
  return {
    innerThought: parsed.data.inner_thought?.trim() ?? '',
    messages,
    mood: mood.success ? mood.data : undefined,
    affinityDelta: delta(parsed.data.affinity_delta),
    trustDelta: delta(parsed.data.trust_delta),
    event: parseEvent(parsed.data.relationship_event),
  };
}

/**
 * 最後手段：模型完全沒照格式、直接回了一段話時，當成純文字訊息。
 * 看起來像壞掉的 JSON 就放棄，避免把 `{"messages": [` 這種東西送給玩家。
 */
export function plainTextFallback(text: string): ReplyOutput | null {
  const t = text.trim();
  if (!t || /[{}[\]]/.test(t.slice(0, 2)) || /"messages"\s*:/.test(t)) return null;
  const messages = clean(t.split(/\n\s*\n/));
  return messages.length ? { innerThought: '', messages, affinityDelta: 0, trustDelta: 0, event: null } : null;
}
