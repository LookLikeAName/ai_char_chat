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
  /** 心動的變化；只有 prompt 有要求時才會有 */
  romanceDelta: number;
  event: { type: RelationshipEventType; note: string } | null;
  /** 群組：對其他成員的好感變化（名字 → 變化量） */
  othersAffinity: Record<string, number>;
  /** 想傳的照片：內容描述（會拿去生成圖片）；不傳為 null */
  photo: string | null;
  /** 見面時：一段一段的旁白與台詞（傳訊息時是空的） */
  beats: Beat[];
  /** 見面時：avatar 決定結束這次見面 */
  leave: boolean;
  /** 產生這個輸出的 LLM 呼叫（監控用） */
  traceId?: string | null;
}

export interface Beat {
  narration: string;
  say: string;
}

const MAX_MESSAGES = 6;
const MAX_NARRATION_CHARS = 600;
const MAX_MESSAGE_CHARS = 1500;
const MAX_PHOTO_CHARS = 500;

const outputSchema = z.object({
  inner_thought: z.string().optional(),
  messages: z.union([z.array(z.string()), z.string()]).optional(),
  message: z.string().optional(),
  // 狀態欄位格式不對時當作沒給，不影響訊息本身
  mood: z.unknown().optional(),
  affinity_delta: z.unknown().optional(),
  trust_delta: z.unknown().optional(),
  romance_delta: z.unknown().optional(),
  relationship_event: z.unknown().optional(),
  photo: z.unknown().optional(),
  others_affinity: z.unknown().optional(),
  beats: z.unknown().optional(),
  leave: z.unknown().optional(),
});

/** 見面的旁白與台詞；也接受 action／speech 之類的別名，或只給一個字串（當作台詞） */
function parseBeats(v: unknown): Beat[] {
  if (!Array.isArray(v)) return [];
  const text = (x: unknown, max: number) => (typeof x === 'string' ? x.trim().slice(0, max) : '');
  return v
    .map((b): Beat => {
      if (typeof b === 'string') return { narration: '', say: text(b, MAX_MESSAGE_CHARS) };
      const o = (b ?? {}) as Record<string, unknown>;
      return {
        narration: text(o.narration ?? o.action ?? o.expression, MAX_NARRATION_CHARS),
        say: text(o.say ?? o.speech ?? o.line ?? o.message, MAX_MESSAGE_CHARS),
      };
    })
    .filter((b) => b.narration || b.say)
    .slice(0, MAX_MESSAGES);
}

function othersAffinity(v: unknown): Record<string, number> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, number> = {};
  for (const [name, d] of Object.entries(v as Record<string, unknown>)) {
    const n = delta(d);
    if (n) out[name] = n;
  }
  return out;
}

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
  const beats = parseBeats(parsed.data.beats);
  // 只給了 beats：訊息就是裡面的台詞
  const messages = clean(typeof raw === 'string' ? [raw] : (raw ?? (beats.length ? beats.map((b) => b.say) : [])));
  const photo = typeof parsed.data.photo === 'string' && parsed.data.photo.trim() ? parsed.data.photo.trim().slice(0, MAX_PHOTO_CHARS) : null;
  // 只傳照片、不說話也可以
  if (!messages.length && !photo && !beats.length && !(opts.allowEmpty && Array.isArray(raw))) return null;
  const mood = moodSchema.safeParse(parsed.data.mood);
  return {
    innerThought: parsed.data.inner_thought?.trim() ?? '',
    messages,
    mood: mood.success ? mood.data : undefined,
    affinityDelta: delta(parsed.data.affinity_delta),
    trustDelta: delta(parsed.data.trust_delta),
    romanceDelta: delta(parsed.data.romance_delta),
    event: parseEvent(parsed.data.relationship_event),
    othersAffinity: othersAffinity(parsed.data.others_affinity),
    photo,
    beats,
    leave: parsed.data.leave === true || parsed.data.leave === 'true',
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
  return messages.length ? { innerThought: '', messages, affinityDelta: 0, trustDelta: 0, romanceDelta: 0, event: null, othersAffinity: {}, photo: null, beats: [], leave: false } : null;
}
