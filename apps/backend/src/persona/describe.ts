// 把人格欄位寫成文字：給系統工具模型看的欄位說明，以及給 avatar 自己看的角色設定。
import {
  BIG_FIVE,
  BIG_FIVE_LABELS,
  ENUM_OPTIONS,
  fieldMeta,
  PERSONA_SECTIONS,
  SCHWARTZ_LABELS,
  SCHWARTZ_VALUES,
  type FieldMeta,
  type Persona,
  type PersonaPath,
  type Schedule,
} from '@acc/shared';

/** 告訴模型這個欄位要什麼格式 */
export function describeFieldType(meta: FieldMeta): string {
  switch (meta.type) {
    case 'text':
      return '字串（一句話以內）';
    case 'long':
      return '字串（2～4 句，具體）';
    case 'list':
      return '字串陣列（2～6 項）';
    case 'number':
      return '整數';
    case 'scale':
      return `0～100 的整數（0 = ${meta.scaleLabels?.[0] ?? '低'}，100 = ${meta.scaleLabels?.[1] ?? '高'}）`;
    case 'select':
      return `以下其中一個值：${Object.entries(meta.options ?? {})
        .map(([k, v]) => `"${k}"（${v}）`)
        .join('、')}`;
    case 'bigFive':
      return `物件 {${BIG_FIVE.map((k) => `"${k}": 0～100`).join(', ')}}（${BIG_FIVE.map((k) => `${k} = ${BIG_FIVE_LABELS[k]}`).join('、')}）`;
    case 'ranking':
      return `陣列，以下 10 個值各出現一次，由最重要排到最不重要：${SCHWARTZ_VALUES.map((v) => `"${v}"（${SCHWARTZ_LABELS[v]}）`).join('、')}`;
    case 'schedule':
      return '物件 {"weekday": [區段…], "weekend": [區段…]}，區段為 {"start": "HH:MM", "end": "HH:MM", "activity": "在做什麼", "status": "free" | "busy" | "sleep"}，要涵蓋一整天（可以跨午夜，例如 23:30～07:30 睡覺）';
  }
}

/**
 * 給 LLM 看的欄位名稱：介面上對玩家說「你」，但模型會搞不清楚「你」是誰，
 * 這裡改寫成明確的說法（玩家在角色設定裡一律稱為「對方」）。
 */
const LLM_FIELD_TEXT: Partial<Record<PersonaPath, { label: string; hint: string }>> = {
  'relationship.withUser': {
    label: '這個角色和玩家的初始關係與認識經過',
    hint: '從這個角色的角度寫，用「對方」指玩家，例如「對方是常來店裡的熟客，最近開始會在打烊後聊天」',
  },
  'relationship.callsUser': { label: '這個角色怎麼稱呼玩家', hint: '暱稱或稱謂，例如「老客人」「學長」' },
};

export function describeField(path: PersonaPath): string {
  const meta = fieldMeta(path)!;
  const text = LLM_FIELD_TEXT[path] ?? { label: meta.label, hint: meta.hint };
  return `- ${path}（${text.label}）：${describeFieldType(meta)}${text.hint ? `。說明：${text.hint}` : ''}`;
}

function level(v: number): string {
  if (v >= 80) return '很高';
  if (v >= 60) return '偏高';
  if (v > 40) return '中等';
  if (v > 20) return '偏低';
  return '很低';
}

function formatSchedule(s: Schedule): string {
  const line = (blocks: Schedule['weekday']) =>
    blocks.map((b) => `${b.start}–${b.end} ${b.activity}（${ENUM_OPTIONS.scheduleStatus[b.status]}）`).join('；');
  return `平日：${line(s.weekday)}\n  假日：${line(s.weekend)}`;
}

function formatValue(path: PersonaPath, value: unknown): string {
  const meta = fieldMeta(path)!;
  switch (meta.type) {
    case 'list':
      return (value as string[]).join('、');
    case 'select':
      return meta.options?.[value as string] ?? String(value);
    case 'scale':
      return `${value}/100（${meta.scaleLabels?.[0]} ↔ ${meta.scaleLabels?.[1]}）`;
    case 'bigFive': {
      const b = value as Persona['personality']['bigFive'];
      return BIG_FIVE.map((k) => `${BIG_FIVE_LABELS[k]} ${b[k]}（${level(b[k])}）`).join('、');
    }
    case 'ranking':
      return (value as string[]).map((v, i) => `${i + 1}. ${SCHWARTZ_LABELS[v as keyof typeof SCHWARTZ_LABELS]}`).join(' ');
    case 'schedule':
      return formatSchedule(value as Schedule);
    default:
      return String(value);
  }
}

/** 給 avatar 自己看的完整角色設定（system prompt 用） */
export function renderPersona(persona: Persona, skip: PersonaPath[] = []): string {
  return PERSONA_SECTIONS.map((section) => {
    const lines = Object.keys(section.fields)
      .map((f) => `${section.key}.${f}`)
      .filter((p) => !skip.includes(p))
      .flatMap((p) => {
        const [s, f] = p.split('.') as [keyof Persona, string];
        // 選填的區塊可能沒有
        const v = (persona[s] as Record<string, unknown> | undefined)?.[f];
        return v === undefined ? [] : [`- ${fieldMeta(p)!.label}：${formatValue(p, v)}`];
      });
    return lines.length ? `## ${section.label}\n${lines.join('\n')}` : '';
  })
    .filter(Boolean)
    .join('\n\n');
}

/** 把草稿中已填的欄位轉成 { "basic.age": 27, … }，給模型當作既定事實 */
export function flatten(draft: Record<string, Record<string, unknown> | undefined>, paths: PersonaPath[]) {
  const out: Record<string, unknown> = {};
  for (const p of paths) {
    const [s, f] = p.split('.');
    const v = draft[s!]?.[f!];
    if (v !== undefined) out[p] = v;
  }
  return out;
}
