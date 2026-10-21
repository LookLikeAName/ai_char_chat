// AI 補完人格設定：玩家填的（與鎖定的）欄位當作既定事實，只產生指定的欄位。
import {
  fieldSchema,

  isFieldFilled,
  isOptionalField,
  missingFields,
  PERSONA_PATHS,
  sanitizeDraft,
  setField,
  STAGE_LABELS,
  unfilledFields,
  type AppSettings,
  type PersonaDraft,
  type PersonaGenerateResult,
  type PersonaPath,
  type personaGenerateSchema,
} from '@acc/shared';
import type { z } from 'zod';
import { referenceSection } from '../services/avatarLinks.ts';
import type { CallContext } from '../services/llmCall.ts';
import { describeField, flatten } from './describe.ts';
import { callUtility, parseJsonObject } from './utility.ts';

const SYSTEM = `你是角色設計師，替一款聊天模擬遊戲設計像真人一樣立體、前後一致的角色。
遊戲的使用者（下稱「玩家」）會先描述想要的角色，再用通訊軟體和角色聊天、交朋友，甚至談戀愛。你要設計的是角色本身，不是玩家。
角色一律是成年人（18 歲以上）。只輸出 JSON。`;

const RULES = `# 要求
- 像真人：有優點也有缺點、有自己的矛盾；細節要具體（地點、店名、習慣、小故事），避免完美、刻板或空泛的形容詞。
- 必須和「已經確定的設定」一致；新欄位之間也要互相一致（職業 ↔ 作息、個性 ↔ 說話方式 ↔ 說話範例）。
- 內容用繁體中文（台灣用語），除非角色的背景明顯是其他語言。
- 說話範例要真的像他會傳的訊息，符合語氣、用字、標點與 emoji 習慣。
- 作息用 24 小時制，平日與假日都要涵蓋一整天。`;

const ADULT_RULES = `# 親密與性（這個遊戲開啟了成人內容）
- intimacy 區塊照角色概念如實寫，不要刻意淡化、說教或避開；例如角色概念是炮友，開放程度就要高，喜歡的方式寫具體。
- 底線寫成具體的「不做的事」。角色一律是成年人。`;

const REFERENCE_RULES = `# 和相關的角色
- 共同的事實要對得上：公司或學校的名字、地點、怎麼認識的、認識多久、誰是誰的上司或學長姐。
- 個性、說話方式、興趣要和他們有明顯的差別，不要複製；可以有互補或摩擦。
- 適合的話，把他們寫進家人、人生經歷、人際關係裡（用名字稱呼）。`;

type Input = z.infer<typeof personaGenerateSchema>;

/** 模型可能回巢狀（{"basic": {"age": 27}}）或攤平（{"basic.age": 27}）的格式，兩種都接受 */
function readValue(out: Record<string, unknown>, path: PersonaPath): unknown {
  if (path in out) return out[path];
  const [s, f] = path.split('.');
  const section = out[s!];
  return section && typeof section === 'object' ? (section as Record<string, unknown>)[f!] : undefined;
}

export async function generatePersona(ctx: CallContext, settings: AppSettings, input: Input): Promise<PersonaGenerateResult> {
  const { draft: base } = sanitizeDraft(input.persona);
  const locks = new Set(input.locks);
  // 「親密與性」只有開啟成人內容時才產生
  const adult = settings.adultContent;
  const allowed = (p: PersonaPath) => PERSONA_PATHS.includes(p) && (adult || !isOptionalField(p));
  const targets = (input.only ? input.only.filter(allowed) : adult ? unfilledFields(base) : missingFields(base)).filter(
    // 鎖定的欄位不重新產生；但還沒填的鎖定欄位一樣要補（全部填滿才能儲存）
    (p) => !locks.has(p) || !isFieldFilled(base, p),
  );
  const wantName = !input.name.trim();
  const wantBio = !input.bio.trim();

  let persona: PersonaDraft = base;
  let name = input.name;
  let bio = input.bio;
  const filled: PersonaPath[] = [];
  let pending = targets;
  let errors: Record<PersonaPath, string> = {};
  let lastOutput = '';
  const references = await referenceSection(ctx.db, input.references ?? [], adult);

  // 第一次產生全部；有不合法的值再針對那幾個欄位重試一次
  for (let attempt = 0; attempt < 2 && (pending.length || (attempt === 0 && (wantName || wantBio))); attempt++) {
    const known = PERSONA_PATHS.filter((p) => !pending.includes(p) && isFieldFilled(persona, p));
    const regenerating = pending.filter((p) => isFieldFilled(base, p));
    const content = [
      '# 要設計的角色',
      `名字：${name || '（還沒決定，請一併取一個名字）'}`,
      `簡介：${bio || '（還沒寫，請一併寫一句簡介）'}`,
      input.seed ? `\n## 角色概念（玩家對這個角色的要求，描述的是角色本身，不是玩家）\n${input.seed}` : '',
      input.userStage
        ? `\n## 這個角色和玩家的關係\n目前是「${STAGE_LABELS[input.userStage]}」。relationship 區塊（認識經過、怎麼稱呼玩家）要符合這個程度，不要寫成更熟或更陌生。`
        : '',
      references ? `\n${references}` : '',
      '',
      '# 已經確定的設定（不能改，新內容必須和這些一致）',
      known.length ? JSON.stringify(flatten(persona as never, known), null, 1) : '（還沒有）',
      '',
      '# 請產生這些欄位',
      pending.map(describeField).join('\n'),
      regenerating.length
        ? `\n以下欄位是重新產生，請寫出和原本不同的新版本：\n${JSON.stringify(flatten(base as never, regenerating))}`
        : '',
      Object.keys(errors).length
        ? `\n上一次這些欄位的值不合法，請修正：\n${Object.entries(errors)
            .map(([p, e]) => `- ${p}：${e}`)
            .join('\n')}`
        : '',
      '',
      RULES,
      pending.some((p) => p.startsWith('intimacy.')) ? `\n${ADULT_RULES}` : '',
      references ? `\n${REFERENCE_RULES}` : '',
      '',
      `# 輸出格式
{${wantName && !name ? '"name": "名字", ' : ''}${wantBio && !bio ? '"bio": "一句話簡介", ' : ''}"persona": {"欄位路徑": 值, …}}
persona 裡只放上面要求的欄位，key 用完整路徑（例如 "basic.age"）。`,
    ]
      .filter((l) => l !== '')
      .join('\n');

    lastOutput = await callUtility(ctx, settings, { system: SYSTEM, messages: [{ role: 'user', content }] }, 'persona.generate');
    const out = parseJsonObject(lastOutput);
    if (!out) {
      errors = Object.fromEntries(pending.map((p) => [p, '上一次的輸出不是 JSON']));
      continue;
    }
    if (wantName && !name && typeof out.name === 'string' && out.name.trim()) name = out.name.trim().slice(0, 40);
    if (wantBio && !bio && typeof out.bio === 'string' && out.bio.trim()) bio = out.bio.trim().slice(0, 500);

    const values = (out.persona && typeof out.persona === 'object' ? out.persona : out) as Record<string, unknown>;
    errors = {};
    for (const p of pending) {
      const r = fieldSchema(p)!.safeParse(readValue(values, p));
      if (r.success) {
        persona = setField(persona, p, r.data);
        filled.push(p);
      } else {
        errors[p] = r.error.issues[0]?.message ?? '缺少這個欄位';
      }
    }
    pending = pending.filter((p) => !filled.includes(p));
  }

  return { name, bio, persona, filled, failed: pending };
}

