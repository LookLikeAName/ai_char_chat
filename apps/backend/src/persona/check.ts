// 一致性檢查：找出彼此矛盾的欄位，並提出只修改未鎖定欄位的建議。
import {
  fieldSchema,
  isOptionalField,
  PERSONA_PATHS,
  sanitizeDraft,
  type AppSettings,
  type PersonaIssue,
  STAGE_LABELS,
  type AvatarLink,
  type PersonaPath,
  type Stage,
} from '@acc/shared';
import { referenceSection } from '../services/avatarLinks.ts';
import type { CallContext } from '../services/llmCall.ts';
import { flatten } from './describe.ts';
import { callUtility, parseJsonObject } from './utility.ts';

const SYSTEM = '你是嚴謹的角色設計編輯，負責檢查聊天遊戲角色設定的一致性。只輸出 JSON。';
const MAX_ISSUES = 6;

export async function checkPersona(
  ctx: CallContext,
  settings: AppSettings,
  input: { name: string; bio: string; persona: Record<string, unknown>; locks: string[]; references?: AvatarLink[]; userStage?: Stage },
): Promise<PersonaIssue[]> {
  const { draft } = sanitizeDraft(input.persona);
  const locks = new Set(input.locks);
  const adult = settings.adultContent;
  const references = await referenceSection(ctx.db, input.references ?? [], adult);
  const content = `# 角色：${input.name || '（未命名）'}
簡介：${input.bio || '（沒有）'}${input.userStage ? `\n這個角色和玩家（會和角色聊天的遊戲使用者）目前的關係：${STAGE_LABELS[input.userStage]}（relationship 區塊寫得比這更熟或更陌生也算矛盾）` : ''}

# 設定
${JSON.stringify(flatten(draft as never, adult ? PERSONA_PATHS : PERSONA_PATHS.filter((p) => !isOptionalField(p))), null, 1)}

# 鎖定的欄位（不能修改）
${[...locks].join('、') || '（沒有）'}
${references ? `\n${references}\n` : ''}
# 任務
找出彼此矛盾、或明顯不合理到會破壞真實感的地方，例如：極度內向卻是業務、作息和職業衝突、年齡和經歷對不上、說話範例不符合語氣或 emoji 習慣、價值排序和人生目標矛盾。${
    references ? '\n也要檢查和相關的角色有沒有對不上的地方（公司、地點、認識的經過、年齡與上下關係），或個性幾乎一模一樣。只能修改這個角色的欄位。' : ''
  }
人本來就有一些矛盾，有張力但說得通的不算問題；沒問題就不要硬找。

# 輸出格式
{"issues": [{"fields": ["basic.occupation", "personality.bigFive"], "problem": "說明哪裡矛盾", "suggestion": {"basic.occupation": "建議的新值"}}]}
- 最多 ${MAX_ISSUES} 項，最嚴重的放前面。
- suggestion 只能修改沒有鎖定的欄位，值的格式要和原本的欄位相同；沒有可改的就給 {}。
- 沒有問題就輸出 {"issues": []}。`;

  const text = await callUtility(ctx, settings, { system: SYSTEM, messages: [{ role: 'user', content }] }, 'persona.check');
  const out = parseJsonObject(text);
  const raw = Array.isArray(out?.issues) ? (out.issues as unknown[]) : [];
  const issues: PersonaIssue[] = [];
  for (const item of raw.slice(0, MAX_ISSUES)) {
    if (!item || typeof item !== 'object') continue;
    const i = item as { fields?: unknown; problem?: unknown; suggestion?: unknown };
    if (typeof i.problem !== 'string' || !i.problem.trim()) continue;
    const fields = (Array.isArray(i.fields) ? i.fields : []).filter(
      (f): f is PersonaPath => typeof f === 'string' && PERSONA_PATHS.includes(f),
    );
    const suggestion: Record<PersonaPath, unknown> = {};
    for (const [path, value] of Object.entries((i.suggestion as Record<string, unknown>) ?? {})) {
      if (!PERSONA_PATHS.includes(path) || locks.has(path)) continue;
      const r = fieldSchema(path)!.safeParse(value);
      if (r.success) suggestion[path] = r.data;
    }
    issues.push({ fields, problem: i.problem.trim(), suggestion });
  }
  return issues;
}
