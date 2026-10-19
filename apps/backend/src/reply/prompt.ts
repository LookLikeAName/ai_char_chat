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
  type ContentPart,
  type LifeLogEvent,
  type Mood,
  type Persona,
  type PhotoAppears,
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
  /** 群組裡用來分辨是誰說的 */
  senderAvatarId?: string | null;
  content: string;
  createdAt: Date;
  /** 圖片訊息：caption 是圖片內容的文字描述，description 是 avatar 傳的照片想拍的內容 */
  image?: { caption?: string | null; description?: string | null } | null;
}

/** 實際附上圖片的訊息（看得懂圖片的模型、最近幾張）；其他圖片用文字描述 */
export type HistoryImages = Map<HistoryMessage, { mime: string; data: string }>;

/** 一張圖片在字數預算裡算多少 */
const IMAGE_CHARS = 300;

/** 群組聊天的資訊（一對一時省略） */
export interface PromptGroup {
  conversationId: string;
  title: string;
  /** 自己的 avatar id */
  selfId: string;
  /** 其他成員（不含自己） */
  members: { id: string; name: string; bio: string; relationship?: RelationshipState; relation?: string }[];
  /** 玩家在群組裡的名字 */
  userName: string;
  /** 自己的口風（0 大嘴巴～100 守口如瓶） */
  discretion: number;
  /** 這一輪：玩家點名了你 */
  mentioned?: boolean;
  /** 這一輪：在你之前已經回覆的成員 */
  before?: string[];
}

/** 相關的角色（玩家設定的，例如同事）：avatar 生活裡認識的人 */
export interface PromptAcquaintance {
  name: string;
  relation: string;
  bio: string;
  occupation?: string;
  traits?: string[];
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
  /** 依相關度挑出的記憶；visibility：private（私訊得知）、group:<id>、public */
  memories: { content: string; createdAt: Date; visibility?: string }[];
  impression: string | null;
}

/** 這次回覆（或主動傳訊息）的當下情境 */
export interface PromptSituation {
  mode: 'reply' | 'proactive' | 'group';
  /** 回覆時：怎麼看到訊息的 */
  reason?: SeenReason;
  /** 回覆時：玩家第一則還沒讀的訊息，到看到為止過了多久 */
  waitedMs?: number;
  /** 群組：這一輪玩家點名了你 */
  mentioned?: boolean;
  /** 群組：這一輪在你之前已經回覆的成員 */
  before?: string[];
}

export interface ReplyPromptInput {
  avatar: PromptAvatar;
  user?: PromptUser | null;
  state?: PromptState | null;
  situation?: PromptSituation;
  /** 今天的生活日誌（全部；prompt 只放已經發生的） */
  lifeLog?: LifeLogEvent[] | null;
  group?: PromptGroup | null;
  acquaintances?: PromptAcquaintance[];
  settings: Pick<AppSettings, 'timezone' | 'adultContent'>;
  /** 由舊到新 */
  history: HistoryMessage[];
  images?: HistoryImages;
  /** 可以傳照片（有設定圖片模型）；remaining 是今天還能傳幾張，appears／proxy 是它在照片裡怎麼出現 */
  photos?: { remaining: number; appears?: PhotoAppears; proxy?: string } | null;
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
  const { avatar, settings, now, history, user, state, situation, lifeLog, group, photos, acquaintances } = input;
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

  const opening = group
    ? `你是「${avatar.name}」，正在通訊軟體的群組「${group.title}」裡聊天。群組裡有你、對方（${group.userName}），還有${group.members.map((m) => `「${m.name}」`).join('、')}。你是一個真實的人，有自己的生活、想法和情緒，不是 AI 助理。`
    : `你是「${avatar.name}」，正在用手機通訊軟體和對方聊天。你是一個真實的人，有自己的生活、想法和情緒，不是 AI 助理。`;

  return `${opening}

# 你的設定
${avatar.bio || '（沒有額外描述）'}
${persona ? `\n${renderPersona(persona, ['relationship.withUser', 'relationship.callsUser'])}\n` : ''}
# 你和對方
${relationship}
${state ? `\n${stateSection(state, user, now, settings.timezone, group)}\n` : ''}${user ? `\n${userSection(user, stage)}\n` : ''}${group ? `\n${groupSection(group)}\n` : ''}${acquaintanceSection(acquaintances, group)}
# 規則
- 完全以「${avatar.name}」的身分說話，言行符合你的設定（個性、價值觀、說話方式、行為準則）；絕對不要說自己是 AI、模型、程式或角色扮演。
- 像真人傳訊息：口語、自然，${persona ? '長度、拆成幾則、emoji 與標點都照你的「說話方式」' : '通常很短，一次 1～4 則，一則一個想法'}；不要用 Markdown、條列或標題。
- 你有自己的立場：可以不同意、吐槽、開玩笑、拒絕、轉移話題，也可以主動問對方問題；不需要討好對方。秘密不會輕易說出口。
- 不要捏造對方沒說過的事；不知道就問。
- 對方傳來的圖片會附在訊息裡，或用［］寫出內容；像真人一樣對它有反應。看不到內容就直接問。${user?.preferences.avoidTopics.length ? `\n- 對方不想談：${user.preferences.avoidTopics.join('、')}。不要主動提起；對方自己提到時溫和地帶過。` : ''}
- 除非你的設定另有指定，用繁體中文（台灣用語）。${group ? GROUP_RULES : ''}
- ${content}

# 現在
現在時間：${formatNow(now, settings.timezone)}${block ? `\n照你的作息，你現在大概在：${block.activity}（${ENUM_OPTIONS.scheduleStatus[block.status]}）。` : ''}${sinceLast !== null && sinceLast > GAP_NOTE_MS ? `\n距離上一則訊息過了 ${formatGap(sinceLast)}。` : ''}${todaySection(lifeLog, clock.hhmm)}${situationSection(situation, block?.activity, !!group)}

# 輸出格式
只輸出一個 JSON 物件，不要有其他文字：
{"inner_thought": "你此刻心裡的想法（對方看不到，一兩句）", "messages": ["第一則訊息", "第二則訊息"]${state ? `, "mood": {"label": "回完這幾則之後的心情（幾個字）", "valence": -5～5, "energy": -5～5}, "affinity_delta": -3～3, "trust_delta": -3～3, "relationship_event": null${group ? ', "others_affinity": {}' : ''}}` : '}'}${
    state
      ? `
${situation?.mode === 'proactive' || group ? '- 如果現在其實沒什麼想說的，messages 可以是空陣列 []，就不會傳出去。\n' : ''}${group ? '- others_affinity：這段對話讓你對其他成員的好感變化，例如 {"阿哲": 1}；沒有變化就省略。\n' : ''}- affinity_delta／trust_delta：這段互動讓你對對方的好感、信任變化多少。大部分時候是 0 或 ±1，只有真的很開心、感動或受傷才到 ±3。
- relationship_event：平常是 null；只有這次對話中真的發生了下列的事才填 {"type": "…", "note": "一句話說明"}：mutual_feelings（彼此有了好感、開始曖昧）、confession_accepted（接受告白、開始交往）、confession_rejected（拒絕告白）、conflict（吵架）、reconciled（和好）、breakup（分手）。`
      : ''
  }${photos ? photoSection(photos, settings.adultContent) : ''}`;
}

/** 可以傳照片時才出現：什麼時候傳、怎麼描述 */
function photoSection(p: NonNullable<ReplyPromptInput['photos']>, adult: boolean): string {
  if (p.remaining <= 0) return '\n- 今天已經傳了很多照片，這次不要再傳（不要填 photo）。';
  const appears = p.appears ?? 'self';
  const who =
    appears === 'self'
      ? { examples: '或拍一張自拍', detail: '有你自己入鏡（自拍）時寫出表情、動作、穿著。' }
      : appears === 'proxy'
        ? {
            examples: `或拍${p.proxy || '你的玩偶'}`,
            detail: `你不會讓自己入鏡，不拍自拍；想「拍自己」的時候，會改拍${p.proxy || '你的玩偶'}（例如放在桌上、拿在手上），描述它擺在哪裡、什麼姿勢。`,
          }
        : { examples: '', detail: '你不會讓自己入鏡，不拍自拍，照片裡不會出現你的臉。' };
  return `
- photo：平常省略。想用手機傳一張照片時才加上 "photo": "照片的內容"，例如對方想看、你想分享正在吃的東西、看到的風景${who.examples ? `、${who.examples}` : ''}。不要每次都傳，今天最多還能傳 ${p.remaining} 張。
  照片會照你的描述拍出來，所以要具體：拍了什麼、在哪裡、角度與光線。${who.detail}描述用第三人稱寫畫面，不要寫對話。${adult ? '' : '照片內容要適合一般場合。'}
  照片和 messages 會一起傳出；只傳照片的話 messages 可以是 []。`;
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

function situationSection(s: PromptSituation | undefined, activity: string | undefined, inGroup = false): string {
  if (!s || s.mode === 'group') return '';
  if (s.mode === 'proactive' && inGroup) {
    return `\n\n## 這次的情況\n群組裡最近沒什麼人說話，你想開個話題：分享今天發生的事、問大家意見、或丟一個有趣的東西。要自然，像真的朋友群組。`;
  }
  if (s.mode === 'proactive') {
    return `\n\n## 這次的情況\n對方現在沒有在跟你聊天，是你想主動傳訊息給對方。可以聊今天發生的事、追問對方之前提過的事、分享你看到的東西，或只是想念對方；要自然，不要像客服或制式問候。`;
  }
  const waited = s.waitedMs && s.waitedMs > 5 * 60_000 ? formatGap(s.waitedMs) : '';
  const text = s.reason ? SITUATIONS[s.reason](activity ?? '', waited) : '';
  return text ? `\n\n## 這次的情況\n${text}` : '';
}

const GROUP_RULES = `
- 這是群組：不需要每則訊息都回，也不用每次都對玩家說話；可以回應其他成員、接話、吐槽，或只說一句。
- 被點名（@你或叫你的名字）就一定要回應。想叫某個人時，在訊息裡寫「@名字」。
- 不要重複別人剛說過的話；別人已經回答了的事，就換個角度或補充。`;

function groupSection(g: PromptGroup): string {
  const lines = [`## 群組成員`];
  for (const m of g.members) {
    const r = m.relationship;
    lines.push(
      `- ${m.name}：${m.bio || '（沒有簡介）'}${m.relation ? `\n  你們是：${m.relation}` : ''}${r ? `（你們的關係：${STAGE_LABELS[r.stage]}，好感 ${r.affinity}）` : ''}`,
    );
  }
  lines.push(
    '',
    `標記「私下得知」的記憶，是在私訊裡聽說的（「在別的群組聽說」的也一樣不是這裡的人都知道）：${
      g.discretion >= 50
        ? '你口風很緊，不會在群組裡說出來，也不會暗示。'
        : g.discretion >= 25
          ? '原則上不在群組裡說，但你偶爾會不小心透露一點。'
          : '你口風很鬆，可能會不小心在群組裡說溜嘴。'
    }`,
  );
  if (g.mentioned) lines.push('', '這一輪對方點名了你，一定要回應。');
  if (g.before?.length) lines.push('', `這一輪 ${g.before.join('、')} 已經先回了，看得到他們說了什麼。`);
  return lines.join('\n');
}

/** 群組裡已經列在成員的人不重複 */
function acquaintanceSection(list: PromptAcquaintance[] | undefined, group: PromptGroup | null | undefined): string {
  const others = (list ?? []).filter((a) => !group?.members.some((m) => m.name === a.name));
  if (!others.length) return '';
  const lines = others.map((a) => {
    const about = [a.occupation, a.traits?.length ? a.traits.join('、') : ''].filter(Boolean).join('；');
    return `- ${a.name}：${a.relation}${a.bio ? `\n  ${a.bio}` : ''}${about ? `（${about}）` : ''}`;
  });
  return `
## 你生活裡認識的人
${lines.join('\n')}
他們是你真實生活的一部分，聊到相關的事時可以自然地提起（例如工作上的事、一起做過的事）。對方可能也認識他們、私下和他們聊天，但你不知道他們聊了什麼；不要捏造他們跟對方說過的話。
`;
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

/** 群組裡，標出記憶是從哪裡聽來的（私訊、別的群組） */
function memoryMark(visibility: string | undefined, group: PromptGroup | null | undefined): string {
  if (!group || !visibility) return '';
  if (visibility === 'private') return '（私下得知）';
  if (visibility.startsWith('group:') && visibility !== `group:${group.conversationId}`) return '（在別的群組聽說）';
  return '';
}

function stateSection(
  state: PromptState,
  user: PromptUser | null | undefined,
  now: Date,
  timezone: string,
  group?: PromptGroup | null,
): string {
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
        return `- ${shortDate(m.createdAt, timezone)}（${ago < 3_600_000 ? '剛剛' : `${formatGap(ago)}前`}）${memoryMark(m.visibility, group)}：${m.content}`;
      }),
    );
  }
  return lines.filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
}

/**
 * 對話紀錄轉成 user / assistant 交替的訊息。
 * avatar 的連續訊息合成一個 assistant 回合，並寫成和輸出相同的 JSON，讓模型維持格式。
 */
export function buildHistory(history: HistoryMessage[], group?: PromptGroup | null, images: HistoryImages = new Map()): ChatMessage[] {
  const recent = history.slice(-HISTORY_MAX_MESSAGES);
  const size = (m: HistoryMessage) => m.content.length + (m.image ? IMAGE_CHARS : 0);
  // 從最新往回累計字數
  let budget = HISTORY_CHAR_BUDGET;
  let start = recent.length;
  while (start > 0 && budget - size(recent[start - 1]!) >= 0) {
    budget -= size(recent[start - 1]!);
    start--;
  }
  const kept = recent.slice(start);

  type Part = string | { mime: string; data: string };
  const turns: { role: 'user' | 'assistant'; parts: Part[]; photos: string[] }[] = [];
  kept.forEach((m, i) => {
    const prev = kept[i - 1];
    const gap = prev ? m.createdAt.getTime() - prev.createdAt.getTime() : 0;
    // 群組：自己說的是 assistant；玩家與其他成員說的都是 user，前面標上名字
    const mine = m.senderType === 'avatar' && (!group || m.senderAvatarId === group.selfId);
    const role = mine ? 'assistant' : 'user';
    const who = !group || mine ? '' : m.senderType === 'user' ? group.userName : (group.members.find((x) => x.id === m.senderAvatarId)?.name ?? '某位成員');
    let last = turns.at(-1);
    if (!last || last.role !== role) turns.push((last = { role, parts: [], photos: [] }));

    if (mine) {
      // 自己傳過的照片用輸出格式的 photo 欄位表示，模型才知道要怎麼傳
      if (m.image) last.photos.push(m.image.description ?? m.image.caption ?? '一張照片');
      if (m.content) last.parts.push(m.content);
      return;
    }
    const pixels = images.get(m);
    const imageNote = !m.image
      ? ''
      : m.senderType === 'avatar'
        ? `［傳了一張照片：${m.image.description ?? m.image.caption ?? '看不到內容'}］`
        : pixels
          ? '［傳了一張圖片，見下圖］'
          : m.image.caption
            ? `［傳了一張圖片：${m.image.caption}］`
            : '［傳了一張圖片，但你看不到內容］';
    let text = [imageNote, m.content].filter(Boolean).join(' ');
    if (who) text = `${who}：${text}`;
    if (gap > GAP_NOTE_MS) text = `（${formatGap(gap)}後）${text}`;
    last.parts.push(text);
    if (pixels) last.parts.push(pixels);
  });

  return turns.map((t): ChatMessage => {
    if (t.role === 'assistant') {
      const texts = t.parts.filter((p): p is string => typeof p === 'string');
      return { role: 'assistant', content: JSON.stringify(t.photos.length ? { messages: texts, photo: t.photos.at(-1) } : { messages: texts }) };
    }
    if (t.parts.every((p) => typeof p === 'string')) return { role: 'user', content: t.parts.join('\n') };
    // 有圖片：連續的文字併成一段，圖片放在提到它的那一行後面
    const content: ContentPart[] = [];
    for (const p of t.parts) {
      const prevPart = content.at(-1);
      if (typeof p !== 'string') content.push({ type: 'image', mime: p.mime, data: p.data });
      else if (prevPart?.type === 'text') prevPart.text += `\n${p}`;
      else content.push({ type: 'text', text: p });
    }
    return { role: 'user', content };
  });
}

export function buildReplyPrompt(input: ReplyPromptInput): { system: string; messages: ChatMessage[] } {
  return { system: buildSystemPrompt(input), messages: buildHistory(input.history, input.group, input.images) };
}
