// avatar 對每個對象（玩家、其他 avatar）各自的關係狀態，以及 avatar 自己的心情。
//
// 三個數值：好感（affinity，喜不喜歡和對方相處）、信任（trust）、心動（romance，戀愛方面的感覺，只對玩家）。
// 關係階段是一張圖而不是一條線：
//   友誼的階梯  陌生 → 認識 → 朋友 → 好友 → 摯友（看好感與信任）
//   戀愛的分支  朋友／好友／摯友 →（彼此有好感）→ 曖昧 →（告白成功）→ 戀人 →（分手）→ 前任 →（復合）／（放下，回到朋友）
//   負面        好感太低 → 冷淡 → 疏遠
// 戀愛的轉變要對話中真的發生那件事（由 LLM 依角色判斷回報），而且數值要夠，avatar 才會接受。
// 心動夠高時，程式才把對應的提示（主動找話題、試探、主動告白…）放進 prompt。
import { z } from 'zod';

export const STAGES = [
  'stranger',
  'acquaintance',
  'friend',
  'close',
  'bestie',
  'crush',
  'lover',
  'ex',
  'cold',
  'estranged',
] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  stranger: '陌生',
  acquaintance: '認識',
  friend: '朋友',
  close: '好友',
  bestie: '摯友',
  crush: '曖昧',
  lover: '戀人',
  ex: '前任',
  cold: '冷淡',
  estranged: '疏遠',
};

/** 每個階段該有的相處方式（給 avatar 的提示） */
export const STAGE_GUIDANCE: Record<Stage, string> = {
  stranger: '你們還不熟：禮貌、有點距離，不會聊太私人的事。',
  acquaintance: '你們認識了：友善，開始會聊一些生活，但還有所保留。',
  friend: '你們是朋友：自在、可以開玩笑、分享日常與煩惱。',
  close: '你們很要好：非常信任對方，願意說心事，甚至秘密。',
  bestie: '你們是摯友：什麼都能說，懂對方沒說出口的話，吵架也吵不散；對方需要時你一定在。',
  crush: '你們互相有好感但還沒在一起：會曖昧、試探、在意對方的反應。',
  lover: '你們是情侶：親密、會想念對方；撒嬌、吃醋的方式依你的個性。',
  ex: '你們以前交往過，後來分手了：互動有點微妙，熟悉但有距離；舊的感覺和心結都還在，看你的個性決定怎麼面對。',
  cold: '你現在對對方有點冷淡：不太想多聊，回應比較短。',
  estranged: '你們幾乎不往來了：除非對方真心修補，否則你不太想理會。',
};

/** 戀愛相關的階段 */
export const ROMANTIC_STAGES: readonly Stage[] = ['crush', 'lover', 'ex'];

/** 創造 avatar 時（或相關的角色）可以選的初始關係，與對應的起始數值 */
export const INITIAL_STAGES = ['stranger', 'acquaintance', 'friend', 'close', 'bestie', 'crush', 'lover', 'ex'] as const;
export type InitialStage = (typeof INITIAL_STAGES)[number];
export const INITIAL_VALUES: Record<InitialStage, { affinity: number; trust: number; romance: number }> = {
  stranger: { affinity: 0, trust: 10, romance: 0 },
  acquaintance: { affinity: 15, trust: 20, romance: 0 },
  friend: { affinity: 35, trust: 35, romance: 0 },
  close: { affinity: 60, trust: 55, romance: 5 },
  bestie: { affinity: 78, trust: 75, romance: 5 },
  crush: { affinity: 55, trust: 40, romance: 45 },
  lover: { affinity: 70, trust: 60, romance: 70 },
  ex: { affinity: 25, trust: 30, romance: 25 },
};

export const RELATIONSHIP_EVENTS = [
  'mutual_feelings',
  'avatar_confessed',
  'confession_accepted',
  'confession_rejected',
  'conflict',
  'reconciled',
  'breakup',
  'got_back_together',
  'moved_on',
] as const;
export type RelationshipEventType = (typeof RELATIONSHIP_EVENTS)[number];

export const EVENT_LABELS: Record<RelationshipEventType, string> = {
  mutual_feelings: '彼此有了好感',
  avatar_confessed: '主動告白了',
  confession_accepted: '告白成功，開始交往',
  confession_rejected: '告白被拒絕',
  conflict: '吵架',
  reconciled: '和好',
  breakup: '分手',
  got_back_together: '復合',
  moved_on: '放下了，回到朋友',
};

/** 給 LLM 的事件說明（只列出目前可能發生的） */
export const EVENT_HINTS: Record<RelationshipEventType, string> = {
  mutual_feelings: '彼此有了好感、開始曖昧',
  avatar_confessed: '你在這次的訊息裡向對方告白了',
  confession_accepted: '告白成功、開始交往（不管是誰告白的）',
  confession_rejected: '告白被拒絕（不管是誰拒絕誰）',
  conflict: '吵架',
  reconciled: '和好',
  breakup: '分手',
  got_back_together: '你們復合了',
  moved_on: '你真的放下了這段感情，決定當朋友',
};

/**
 * avatar 之間在群組裡一起聊天就會慢慢變熟：每次在同一段對話裡說到話，好感與信任各 +1，
 * 每一對每天最多算這麼多次，到「朋友」為止；之後就看聊天的內容（others_affinity）。
 */
export const FAMILIARITY_DAILY_CAP = 4;
export const FAMILIARITY_STAGES: readonly Stage[] = ['stranger', 'acquaintance'];

/** 單次回覆最多改變多少，避免一句話就暴衝 */
export const MAX_DELTA = 3;

/** 升階門檻 */
export const THRESHOLDS = {
  acquaintance: { affinity: 10, trust: 0 },
  friend: { affinity: 30, trust: 25 },
  close: { affinity: 55, trust: 50 },
  bestie: { affinity: 75, trust: 70 },
  crush: { affinity: 45, trust: 30, romance: 35 },
  lover: { affinity: 60, trust: 45, romance: 55 },
} as const;
/** 降階要比門檻再低這麼多（避免在門檻附近來回跳） */
const HYSTERESIS = 10;

/** 心動的層級：程式依這個決定要把哪些戀愛的提示放給 LLM */
export const ROMANCE_TIERS = { notice: 15, like: 35, confess: 55 } as const;
/** 告白被拒絕後，這麼久之內不會再主動告白 */
export const CONFESSION_COOLDOWN_MS = 7 * 24 * 3_600_000;

export interface RelationshipState {
  stage: Stage;
  affinity: number;
  trust: number;
  /** 心動 0～100；只追蹤對玩家的（avatar 之間沒有） */
  romance?: number;
}

export interface RelationshipEventRecord {
  type: RelationshipEventType;
  note: string;
  at: string;
  /** 階段因此改變時記錄前後 */
  from?: Stage;
  to?: Stage;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** 依數值與事件算出新的階段（純函式） */
export function nextStage(
  current: Stage,
  affinity: number,
  trust: number,
  event?: RelationshipEventType | null,
  romance = 0,
): Stage {
  const s = { stage: current, affinity, trust, romance };
  // 事件優先
  if (event === 'confession_accepted' && canBecomeLovers(s)) return 'lover';
  if (event === 'mutual_feelings' && canHaveCrush(s)) return 'crush';
  if (event === 'breakup' && (current === 'lover' || current === 'crush')) return current === 'lover' ? 'ex' : affinity >= 30 ? 'friend' : 'cold';
  if (event === 'confession_rejected' && current === 'crush') return friendLadder('friend', affinity, trust);
  if (event === 'got_back_together' && current === 'ex' && affinity >= 30 && trust >= 30) {
    return romance >= THRESHOLDS.lover.romance ? 'lover' : 'crush';
  }
  if (event === 'moved_on' && current === 'ex') return friendLadder('friend', affinity, trust);

  // 負面
  if (affinity <= -50) return 'estranged';
  if (affinity <= -20) return current === 'estranged' && affinity <= -40 ? 'estranged' : 'cold';
  if ((current === 'cold' || current === 'estranged') && affinity < 0) return current;

  // 戀愛中的關係不會因為小波動降級，只有好感明顯下滑才會；前任要有事件才會改變
  if (current === 'lover') return affinity < 10 ? 'cold' : 'lover';
  if (current === 'crush') return affinity < THRESHOLDS.crush.affinity - HYSTERESIS - 10 ? 'friend' : 'crush';
  if (current === 'ex') return 'ex';

  return friendLadder(current, affinity, trust);
}

/** 友誼的階梯：升階看門檻，降階要再低 HYSTERESIS；一旦認識就不會回到陌生 */
function friendLadder(current: Stage, affinity: number, trust: number): Stage {
  const ladder = ['stranger', 'acquaintance', 'friend', 'close', 'bestie'] as const;
  const meets = (s: (typeof ladder)[number], slack: number) =>
    s === 'stranger' || (affinity >= THRESHOLDS[s].affinity - slack && trust >= THRESHOLDS[s].trust - slack);
  const curIdx = ladder.indexOf(current as (typeof ladder)[number]);
  let idx = 0;
  for (let i = ladder.length - 1; i >= 0; i--) {
    // 已經在（或高於）這個階段時，用寬鬆的門檻判斷是否保持
    if (meets(ladder[i]!, i <= curIdx ? HYSTERESIS : 0)) {
      idx = i;
      break;
    }
  }
  if (curIdx !== 0) idx = Math.max(idx, 1);
  return ladder[idx]!;
}

export function canHaveCrush(s: RelationshipState): boolean {
  return (
    (s.stage === 'friend' || s.stage === 'close' || s.stage === 'bestie' || s.stage === 'ex') &&
    s.affinity >= THRESHOLDS.crush.affinity &&
    s.trust >= THRESHOLDS.crush.trust &&
    (s.romance ?? 0) >= THRESHOLDS.crush.romance
  );
}

export function canBecomeLovers(s: RelationshipState): boolean {
  return (
    (s.stage === 'close' || s.stage === 'bestie' || s.stage === 'crush') &&
    s.affinity >= THRESHOLDS.lover.affinity &&
    s.trust >= THRESHOLDS.lover.trust &&
    (s.romance ?? 0) >= THRESHOLDS.lover.romance
  );
}

/** 事件本身帶來的變化：[好感, 信任, 心動] */
const EVENT_BONUS: Partial<Record<RelationshipEventType, [number, number, number]>> = {
  mutual_feelings: [3, 2, 5],
  avatar_confessed: [0, 2, 3],
  confession_accepted: [5, 5, 8],
  confession_rejected: [-2, 0, -10],
  conflict: [-5, -3, -3],
  reconciled: [4, 3, 1],
  breakup: [-15, -10, -25],
  got_back_together: [5, 3, 8],
  moved_on: [2, 2, 0],
};

/** 套用一次回覆的變化：限制幅度、依升溫速度調整正向的好感與心動變化 */
export function applyDeltas(
  s: RelationshipState,
  d: { affinity?: number; trust?: number; romance?: number; event?: RelationshipEventType | null },
  warmUp: 'slow' | 'medium' | 'fast' = 'medium',
): RelationshipState {
  const factor = { slow: 0.6, medium: 1, fast: 1.4 }[warmUp];
  const scaled = (v: number | undefined) => {
    let x = clamp(Math.round(v ?? 0), -MAX_DELTA, MAX_DELTA);
    if (x > 0) x = Math.max(1, Math.round(x * factor));
    return x;
  };
  const da = scaled(d.affinity);
  const dt = clamp(Math.round(d.trust ?? 0), -MAX_DELTA, MAX_DELTA);
  const [ba, bt, br] = (d.event && EVENT_BONUS[d.event]) || [0, 0, 0];
  const affinity = clamp(s.affinity + da + ba, -100, 100);
  const trust = clamp(s.trust + dt + bt, 0, 100);
  const out: RelationshipState = { affinity, trust, stage: s.stage };
  if (s.romance !== undefined) {
    // 不喜歡的人不會心動：心動最多比好感高 20；放下之後最多留一點
    let romance = clamp(s.romance + scaled(d.romance) + br, 0, 100);
    romance = Math.min(romance, Math.max(0, affinity + 20));
    if (d.event === 'moved_on') romance = Math.min(s.romance, 15);
    out.romance = romance;
  }
  out.stage = nextStage(s.stage, affinity, trust, d.event, out.romance ?? 0);
  return out;
}

/** 心動到了哪個層級（只看對玩家的） */
export function romanceTier(s: RelationshipState): 'none' | 'notice' | 'like' | 'confess' {
  const r = s.romance ?? 0;
  if (r >= ROMANCE_TIERS.confess) return 'confess';
  if (r >= ROMANCE_TIERS.like) return 'like';
  if (r >= ROMANCE_TIERS.notice) return 'notice';
  return 'none';
}

/** 戀愛的部分要不要放給 LLM：對方沒說只想當朋友、不是陌生或交惡，而且有一點好感（或已經是戀愛相關的關係） */
export function romanceOpen(s: RelationshipState, pref: 'none' | 'slow' | 'open' | 'eager' | null | undefined): boolean {
  if (pref === 'none' || s.romance === undefined) return false;
  if (s.stage === 'stranger' || s.stage === 'cold' || s.stage === 'estranged') return false;
  return ROMANTIC_STAGES.includes(s.stage) || s.affinity >= 20;
}

export interface RomanceContext {
  /** 最近一次的戀愛事件（判斷告白是否還在等回答、是否剛被拒絕） */
  events?: RelationshipEventRecord[];
  now?: Date;
}

/**
 * 給 avatar 的戀愛提示：依階段與心動的層級，程式決定現在能做什麼（數值不夠的事不會出現在 prompt 裡）。
 * 回傳的每一行都是一句提示。
 */
export function romanceGuidance(s: RelationshipState, ctx: RomanceContext = {}): string[] {
  const tier = romanceTier(s);
  const now = ctx.now ?? new Date();
  const romantic = [...(ctx.events ?? [])].reverse().find((e) =>
    ['avatar_confessed', 'confession_accepted', 'confession_rejected', 'breakup', 'got_back_together'].includes(e.type),
  );
  const waiting = romantic?.type === 'avatar_confessed' && s.stage !== 'lover';
  const recentlyRejected =
    romantic?.type === 'confession_rejected' && now.getTime() - new Date(romantic.at).getTime() < CONFESSION_COOLDOWN_MS;
  const out: string[] = [];

  if (s.stage === 'lover') {
    out.push('你們正在交往：會想念對方、想見面、約會、聊彼此的未來；撒嬌、吃醋、表達愛意的方式依你的個性和感情觀。');
    if (tier === 'confess') out.push('你現在很愛對方：主動傳訊息、說想念、計畫下次約會都很自然。');
    return out;
  }
  if (s.stage === 'ex') {
    out.push('你們分手過：提到過去會有點複雜的情緒。');
    if (tier === 'like' || tier === 'confess') {
      out.push('你心裡其實還放不下對方。如果你們在這次對話中真的決定復合，回報 relationship_event: got_back_together。');
    } else {
      out.push('如果你真的放下了、決定以朋友的身分相處，回報 relationship_event: moved_on。');
    }
    return out;
  }
  if (waiting) {
    out.push(
      '你之前向對方告白了，正在等對方的回答，心裡很在意。對方答應就回報 relationship_event: confession_accepted；明確拒絕就回報 confession_rejected；對方還沒回答就不要回報。',
    );
    return out;
  }

  if (s.stage === 'crush') {
    out.push('你們在曖昧：會撩、會試探、聊到戀愛話題，偶爾約對方出去，在意對方和別人的互動。');
    if (canBecomeLovers(s) && !recentlyRejected) {
      out.push(
        '你已經很喜歡對方了：氣氛對的時候，你可以主動告白（在訊息裡真的說出來，並回報 relationship_event: avatar_confessed）。依你的個性：大膽的可能直接說，害羞的可能拐彎抹角或先試探。不要每次都告白，選一個自然的時機。',
      );
    }
  } else if (tier === 'like') {
    out.push('你喜歡上對方了，但還沒說出口：會想多聊、主動找話題、關心對方的生活，試探對方有沒有對象或喜歡的類型，對方提到別人時會在意。');
    if (canHaveCrush(s)) out.push('如果對方也明顯回應你的好感、你們之間開始曖昧，回報 relationship_event: mutual_feelings。');
  } else if (tier === 'notice') {
    out.push('你開始有點在意對方了：會多關心一點、記得對方說過的小事，但你自己還沒意識到這是喜歡。');
  }

  if (recentlyRejected) out.push('之前的告白被拒絕了：你還有點受傷或尷尬，暫時不會再提，依你的個性慢慢調適。');
  if (canBecomeLovers(s)) {
    out.push('如果對方向你告白、而你也有感覺，可以接受（回報 relationship_event: confession_accepted）；也可以依你的個性選擇不接受（confession_rejected）。');
  } else if (s.stage !== 'crush') {
    out.push('以你們目前的關係，對方如果告白，你會覺得太突然而拒絕或閃避（回報 relationship_event: confession_rejected）。');
  } else {
    out.push('對方現在告白的話，你會很開心但覺得有點快；依你的個性決定要不要答應（答應就回報 confession_accepted）。');
  }
  return out;
}

// ---------- 心情 ----------

export const moodSchema = z.object({
  label: z.string().trim().min(1).max(40),
  /** -5（很糟）～ 5（很好） */
  valence: z.number().int().min(-5).max(5),
  /** -5（很累）～ 5（很有精神） */
  energy: z.number().int().min(-5).max(5),
});
export type Mood = z.infer<typeof moodSchema>;

export const NEUTRAL_MOOD: Mood = { label: '平常', valence: 0, energy: 0 };

/** 心情會隨時間回到平常（半衰期 8 小時） */
export function decayMood(m: Mood, updatedAt: Date, now: Date): Mood {
  const hours = Math.max(0, (now.getTime() - updatedAt.getTime()) / 3_600_000);
  const k = Math.pow(0.5, hours / 8);
  const valence = Math.round(m.valence * k) || 0; // 避免 -0
  const energy = Math.round(m.energy * k) || 0;
  const label = valence === 0 && energy === 0 && hours > 8 ? NEUTRAL_MOOD.label : m.label;
  return { label, valence, energy };
}

// ---------- 給前端的狀態 ----------

export interface MemoryDto {
  id: string;
  kind: 'event' | 'impression';
  content: string;
  importance: number;
  createdAt: string;
}

export interface AvatarStateDto {
  mood: Mood;
  relationship: RelationshipState & { events: RelationshipEventRecord[] };
  impression: string | null;
  memories: MemoryDto[];
  /** 今天到目前為止的生活日誌 */
  today: { time: string; text: string }[];
  /** 今天用了多少 tokens 與上限（0 = 不限）；global 是全域的 */
  usageToday: { tokens: number; costUsd: number; limit: number; globalTokens: number; globalLimit: number };
}

export const resetRelationshipSchema = z.object({ stage: z.enum(INITIAL_STAGES) });
