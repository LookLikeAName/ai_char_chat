// 組出一對一回覆的 prompt。順序：角色設定（固定，利於快取）→ 規則 → 現在的情境 → 對話紀錄。
import {
  currentBlock,
  ENUM_OPTIONS,
  eventsSoFar,
  localClock,
  personaSchema,
  romanceGuidance,
  ROMANCE_PREFS,
  STAGE_GUIDANCE,
  STAGE_LABELS,
  type AppSettings,
  type AssessmentResults,
  type LifeLogEvent,
  type Mood,
  type Persona,
  type PersonaDraft,
  type Preferences,
  type RelationshipState,
  type SeenReason,
  type Stage,
} from '@acc/shared';

export { localClock };
import type { ChatMessage } from '../llm/index.ts';
import { renderPersona } from '../persona/describe.ts';
import { describePreferences, describeResults } from '../profile/describe.ts';

export interface PromptAvatar {
  name: string;
  bio: string;
  persona: PersonaDraft;
}

export interface HistoryMessage {
  senderType: 'user' | 'avatar';
  content: string;
  createdAt: Date;
}

/** 玩家的 profile；還沒填偏好問卷時為 null */
export interface PromptUser {
  preferences: Preferences;
  summary: string;
  results: AssessmentResults;
}

/** avatar 的動態狀態（第 5 階段） */
export interface PromptState {
  relationship: RelationshipState;
  mood: Mood;
  /** 依相關度挑出的記憶 */
  memories: { content: string; createdAt: Date }[];
  impression: string | null;
}

/** 這次回覆（或主動傳訊息）的當下情境 */
export interface PromptSituation {
  mode: 'reply' | 'proactive';
  /** 回覆時：怎麼看到訊息的 */
  reason?: SeenReason;
  /** 回覆時：玩家第一則還沒讀的訊息，到看到為止過了多久 */
  waitedMs?: number;
}

export interface ReplyPromptInput {
  avatar: PromptAvatar;
  user?: PromptUser | null;
  state?: PromptState | null;
  situation?: PromptSituation;
  /** 今天的生活日誌（全部；prompt 只放已經發生的） */
  lifeLog?: LifeLogEvent[] | null;
  settings: Pick<AppSettings, 'timezone' | 'adultContent'>;
  /** 由舊到新 */
  history: HistoryMessage[];
  now: Date;
}

/** 對話紀錄的字數上限（大約 8k tokens），超過就從最舊的開始捨棄 */
const HISTORY_CHAR_BUDGET = 16_000;
const HISTORY_MAX_MESSAGES = 80;
/** 兩則訊息相隔超過這個時間，就在紀錄裡標註過了多久 */
const GAP_NOTE_MS = 60 * 60 * 1000;

export function formatNow(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: timezone,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
}

export function formatGap(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} 分鐘`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} 小時`;
  return `${Math.round(hours / 24)} 天`;
}

/** 完整的人格設定；還沒建立（或不完整）時回傳 null，只用簡介 */
export function completePersona(draft: PersonaDraft): Persona | null {
  const r = personaSchema.safeParse(draft);
  return r.success ? r.data : null;
}

export function buildSystemPrompt(input: ReplyPromptInput): string {
  const { avatar, settings, now, history, user, state, situation, lifeLog } = input;
  const stage: Stage = state?.relationship.stage ?? 'acquaintance';
  const persona = completePersona(avatar.persona);
  // 玩家最新這串訊息之前的最後一則（通常是 avatar 上次說的話）
  let i = history.length - 1;
  while (i >= 0 && history[i]!.senderType === 'user') i--;
  const before = history[i];
  const sinceLast = before ? now.getTime() - before.createdAt.getTime() : null;

  const content = settings.adultContent
    ? '允許成人內容。你和對方都是成年人；是否發展到親密或露骨的內容，取決於你的個性、你們的關係和當下的氣氛，你可以拒絕。'
    : '不寫露骨的性內容。對方往這個方向帶時，用符合你個性的方式婉拒、害羞帶過或轉移話題。';

  const clock = localClock(now, settings.timezone);
  const block = persona ? currentBlock(persona.routine.schedule, clock.weekend, clock.hhmm) : null;
  const relationship = persona
    ? `${persona.relationship.withUser}\n你稱呼對方「${persona.relationship.callsUser}」。`
    : '你們的關係還沒有特別設定：就當作透過朋友認識不久、正在慢慢熟悉的人。';

  return `你是「${avatar.name}」，正在用手機通訊軟體和對方聊天。你是一個真實的人，有自己的生活、想法和情緒，不是 AI 助理。

# 你的設定
${avatar.bio || '（沒有額外描述）'}
${persona ? `\n${renderPersona(persona, ['relationship.withUser', 'relationship.callsUser'])}\n` : ''}
# 你和對方
${relationship}
${state ? `\n${stateSection(state, user, now, settings.timezone)}\n` : ''}${user ? `\n${userSection(user, stage)}\n` : ''}
# 規則
- 完全以「${avatar.name}」的身分說話，言行符合你的設定（個性、價值觀、說話方式、行為準則）；絕對不要說自己是 AI、模型、程式或角色扮演。
- 像真人傳訊息：口語、自然，${persona ? '長度、拆成幾則、emoji 與標點都照你的「說話方式」' : '通常很短，一次 1～4 則，一則一個想法'}；不要用 Markdown、條列或標題。
- 你有自己的立場：可以不同意、吐槽、開玩笑、拒絕、轉移話題，也可以主動問對方問題；不需要討好對方。秘密不會輕易說出口。
- 不要捏造對方沒說過的事；不知道就問。${user?.preferences.avoidTopics.length ? `\n- 對方不想談：${user.preferences.avoidTopics.join('、')}。不要主動提起；對方自己提到時溫和地帶過。` : ''}
- 除非你的設定另有指定，用繁體中文（台灣用語）。
- ${content}

# 現在
現在時間：${formatNow(now, settings.timezone)}${block ? `\n照你的作息，你現在大概在：${block.activity}（${ENUM_OPTIONS.scheduleStatus[block.status]}）。` : ''}${sinceLast !== null && sinceLast > GAP_NOTE_MS ? `\n距離上一則訊息過了 ${formatGap(sinceLast)}。` : ''}${todaySection(lifeLog, clock.hhmm)}${situationSection(situation, block?.activity)}

# 輸出格式
只輸出一個 JSON 物件，不要有其他文字：
{"inner_thought": "你此刻心裡的想法（對方看不到，一兩句）", "messages": ["第一則訊息", "第二則訊息"]${state ? `, "mood": {"label": "回完這幾則之後的心情（幾個字）", "valence": -5～5, "energy": -5～5}, "affinity_delta": -3～3, "trust_delta": -3～3, "relationship_event": null}` : '}'}${
    state
      ? `
${situation?.mode === 'proactive' ? '- 如果現在其實沒什麼想說的，messages 可以是空陣列 []，就不會傳出去。\n' : ''}- affinity_delta／trust_delta：這段互動讓你對對方的好感、信任變化多少。大部分時候是 0 或 ±1，只有真的很開心、感動或受傷才到 ±3。
- relationship_event：平常是 null；只有這次對話中真的發生了下列的事才填 {"type": "…", "note": "一句話說明"}：mutual_feelings（彼此有了好感、開始曖昧）、confession_accepted（接受告白、開始交往）、confession_rejected（拒絕告白）、conflict（吵架）、reconciled（和好）、breakup（分手）。`
      : ''
  }`;
}

function todaySection(log: LifeLogEvent[] | null | undefined, hhmm: string): string {
  const done = log ? eventsSoFar(log, hhmm) : [];
  if (!done.length) return '';
  return `\n\n## 你今天到目前為止\n${done.map((e) => `- ${e.time} ${e.text}`).join('\n')}`;
}

const SITUATIONS: Record<SeenReason, (activity: string, waited: string) => string> = {
  normal: () => '',
  peek: (a) => `你正在${a || '忙'}，抽空偷看手機回一下。`,
  late: (a, w) => `你剛剛在${a || '忙'}，${w ? `過了 ${w}才看到` : '現在才看到'}對方的訊息。`,
  interrupted: (a) => `你正在${a || '忙'}，對方一直傳訊息，你只好先停下來看手機。依你的個性反應（可能有點煩、也可能擔心對方怎麼了）。`,
  woken: () => '你原本在睡覺，被對方連續的訊息吵醒了。依你的個性反應（可能迷糊、有點不爽，或擔心對方出了什麼事）。',
};

function situationSection(s: PromptSituation | undefined, activity: string | undefined): string {
  if (!s) return '';
  if (s.mode === 'proactive') {
    return `\n\n## 這次的情況\n對方現在沒有在跟你聊天，是你想主動傳訊息給對方。可以聊今天發生的事、追問對方之前提過的事、分享你看到的東西，或只是想念對方；要自然，不要像客服或制式問候。`;
  }
  const waited = s.waitedMs && s.waitedMs > 5 * 60_000 ? formatGap(s.waitedMs) : '';
  const text = s.reason ? SITUATIONS[s.reason](activity ?? '', waited) : '';
  return text ? `\n\n## 這次的情況\n${text}` : '';
}

const FAMILIAR: Stage[] = ['friend', 'close', 'crush', 'lover'];

/**
 * 關於玩家的參考資料，依關係深淺逐步透露：剛認識只知道稱呼，認識之後知道偏好，成為朋友後才有整體的感覺（摘要）。
 * avatar 應該把這些當成相處下來的直覺，不能說出「測驗」「分析」之類的話。
 */
export function userSection(user: PromptUser, stage: Stage): string {
  const name = `對方的名字（希望被這樣稱呼）：${user.preferences.nickname}`;
  if (stage === 'stranger') return `${name}\n你對對方還不太了解，想知道什麼就自己問。`;
  const prefs = describePreferences(user.preferences)
    .filter((l) => !l.startsWith('希望被稱呼為'))
    .map((l) => `- ${l}`);
  if (!FAMILIAR.includes(stage)) {
    return `${name}

## 你目前知道的對方（相處下來大概知道的；不要提到測驗或問卷，也不要一次全講出來）
${prefs.join('\n') || '- （還不太了解）'}`;
  }
  const body = user.summary.trim() ? user.summary.trim() : describeResults(user.results).map((l) => `- ${l}`).join('\n');
  return `${name}

## 關於對方（你相處下來大概感覺得到的；不要提到測驗、分數或分析，也不要一次把知道的都講出來）
${[body, prefs.join('\n')].filter(Boolean).join('\n')}`;
}

function shortDate(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat('zh-TW', { timeZone: timezone, month: 'numeric', day: 'numeric' }).format(d);
}

function stateSection(state: PromptState, user: PromptUser | null | undefined, now: Date, timezone: string): string {
  const r = state.relationship;
  const romancePref = user?.preferences.romance;
  const lines = [
    `## 你們的關係：${STAGE_LABELS[r.stage]}（好感 ${r.affinity}/100、信任 ${r.trust}/100）`,
    STAGE_GUIDANCE[r.stage],
    romanceGuidance(r),
    romancePref === 'none' ? '對方表示只想當朋友：不要主動往戀愛發展。' : romancePref ? `對方對戀愛的態度：${ROMANCE_PREFS[romancePref]}。` : '',
    '',
    `## 你現在的心情：${state.mood.label}（心情 ${state.mood.valence}、精神 ${state.mood.energy}，範圍 -5～5）`,
  ];
  if (state.impression) lines.push('', '## 你對對方的印象', state.impression);
  if (state.memories.length) {
    lines.push(
      '',
      '## 你記得的事（自然地想起來就好，不要硬塞進對話）',
      ...state.memories.map((m) => {
        const ago = now.getTime() - m.createdAt.getTime();
        return `- ${shortDate(m.createdAt, timezone)}（${ago < 3_600_000 ? '剛剛' : `${formatGap(ago)}前`}）：${m.content}`;
      }),
    );
  }
  return lines.filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
}

/**
 * 對話紀錄轉成 user / assistant 交替的訊息。
 * avatar 的連續訊息合成一個 assistant 回合，並寫成和輸出相同的 JSON，讓模型維持格式。
 */
export function buildHistory(history: HistoryMessage[]): ChatMessage[] {
  const recent = history.slice(-HISTORY_MAX_MESSAGES);
  // 從最新往回累計字數
  let budget = HISTORY_CHAR_BUDGET;
  let start = recent.length;
  while (start > 0 && budget - recent[start - 1]!.content.length >= 0) {
    budget -= recent[start - 1]!.content.length;
    start--;
  }
  const kept = recent.slice(start);

  const turns: { role: 'user' | 'assistant'; parts: string[] }[] = [];
  kept.forEach((m, i) => {
    const prev = kept[i - 1];
    const gap = prev ? m.createdAt.getTime() - prev.createdAt.getTime() : 0;
    const role = m.senderType === 'user' ? 'user' : 'assistant';
    let text = m.content;
    if (gap > GAP_NOTE_MS && role === 'user') text = `（${formatGap(gap)}後）${text}`;
    const last = turns.at(-1);
    if (last && last.role === role) last.parts.push(text);
    else turns.push({ role, parts: [text] });
  });

  return turns.map((t) => ({
    role: t.role,
    content: t.role === 'user' ? t.parts.join('\n') : JSON.stringify({ messages: t.parts }),
  }));
}

export function buildReplyPrompt(input: ReplyPromptInput): { system: string; messages: ChatMessage[] } {
  return { system: buildSystemPrompt(input), messages: buildHistory(input.history) };
}
