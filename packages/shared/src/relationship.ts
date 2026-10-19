// avatar 對每個對象（玩家、其他 avatar）各自的關係狀態，以及 avatar 自己的心情。
//
// 關係階段由數值門檻 + 事件決定：好感、信任靠平常的互動累積；
// 要變成曖昧或戀人，還需要對話中真的發生那件事（由 LLM 依角色判斷回報），而且數值要夠，avatar 才會接受。
import { z } from 'zod';

export const STAGES = ['stranger', 'acquaintance', 'friend', 'close', 'crush', 'lover', 'cold', 'estranged'] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  stranger: '陌生',
  acquaintance: '認識',
  friend: '朋友',
  close: '好友',
  crush: '曖昧',
  lover: '戀人',
  cold: '冷淡',
  estranged: '疏遠',
};

/** 每個階段該有的相處方式（給 avatar 的提示） */
export const STAGE_GUIDANCE: Record<Stage, string> = {
  stranger: '你們還不熟：禮貌、有點距離，不會聊太私人的事。',
  acquaintance: '你們認識了：友善，開始會聊一些生活，但還有所保留。',
  friend: '你們是朋友：自在、可以開玩笑、分享日常與煩惱。',
  close: '你們很要好：非常信任對方，願意說心事，甚至秘密。',
  crush: '你們互相有好感但還沒在一起：會曖昧、試探、在意對方的反應。',
  lover: '你們是情侶：親密、會想念對方；撒嬌、吃醋的方式依你的個性。',
  cold: '你現在對對方有點冷淡：不太想多聊，回應比較短。',
  estranged: '你們幾乎不往來了：除非對方真心修補，否則你不太想理會。',
};

/** 創造 avatar 時可以選的初始關係，與對應的起始數值 */
export const INITIAL_STAGES = ['stranger', 'acquaintance', 'friend', 'close'] as const;
export type InitialStage = (typeof INITIAL_STAGES)[number];
export const INITIAL_VALUES: Record<InitialStage, { affinity: number; trust: number }> = {
  stranger: { affinity: 0, trust: 10 },
  acquaintance: { affinity: 15, trust: 20 },
  friend: { affinity: 35, trust: 35 },
  close: { affinity: 60, trust: 55 },
};

export const RELATIONSHIP_EVENTS = [
  'mutual_feelings',
  'confession_accepted',
  'confession_rejected',
  'conflict',
  'reconciled',
  'breakup',
] as const;
export type RelationshipEventType = (typeof RELATIONSHIP_EVENTS)[number];

export const EVENT_LABELS: Record<RelationshipEventType, string> = {
  mutual_feelings: '彼此有了好感',
  confession_accepted: '接受了告白，開始交往',
  confession_rejected: '拒絕了告白',
  conflict: '吵架',
  reconciled: '和好',
  breakup: '分手',
};

/** 單次回覆最多改變多少，避免一句話就暴衝 */
export const MAX_DELTA = 3;

/** 升階門檻 */
export const THRESHOLDS = {
  acquaintance: { affinity: 10, trust: 0 },
  friend: { affinity: 30, trust: 25 },
  close: { affinity: 55, trust: 50 },
  crush: { affinity: 45, trust: 30 },
  lover: { affinity: 60, trust: 45 },
} as const;
/** 降階要比門檻再低這麼多（避免在門檻附近來回跳） */
const HYSTERESIS = 10;

export interface RelationshipState {
  stage: Stage;
  affinity: number;
  trust: number;
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
export function nextStage(current: Stage, affinity: number, trust: number, event?: RelationshipEventType | null): Stage {
  // 事件優先
  if (event === 'confession_accepted' && canBecomeLovers({ stage: current, affinity, trust })) return 'lover';
  if (event === 'mutual_feelings' && canHaveCrush({ stage: current, affinity, trust })) return 'crush';
  if (event === 'breakup' && (current === 'lover' || current === 'crush')) return affinity >= 30 ? 'friend' : 'cold';

  // 負面
  if (affinity <= -50) return 'estranged';
  if (affinity <= -20) return current === 'estranged' && affinity <= -40 ? 'estranged' : 'cold';
  if ((current === 'cold' || current === 'estranged') && affinity < 0) return current;

  // 戀愛中的關係不會因為小波動降級，只有好感明顯下滑才會
  if (current === 'lover') return affinity < 10 ? 'cold' : 'lover';
  if (current === 'crush') return affinity < THRESHOLDS.crush.affinity - HYSTERESIS - 10 ? 'friend' : 'crush';

  // 友誼的階梯：升階看門檻，降階要再低 HYSTERESIS
  const ladder = ['stranger', 'acquaintance', 'friend', 'close'] as const;
  const meets = (s: (typeof ladder)[number], slack: number) =>
    s === 'stranger' ||
    (affinity >= THRESHOLDS[s].affinity - slack && trust >= THRESHOLDS[s].trust - slack);
  const curIdx = ladder.indexOf(current as (typeof ladder)[number]);
  let idx = 0;
  for (let i = ladder.length - 1; i >= 0; i--) {
    // 已經在（或高於）這個階段時，用寬鬆的門檻判斷是否保持
    if (meets(ladder[i]!, i <= curIdx ? HYSTERESIS : 0)) {
      idx = i;
      break;
    }
  }
  // 一旦認識就不會回到陌生
  if (curIdx >= 1 || current === 'cold' || current === 'estranged') idx = Math.max(idx, 1);
  return ladder[idx]!;
}

export function canHaveCrush(s: RelationshipState): boolean {
  return (
    (s.stage === 'friend' || s.stage === 'close') &&
    s.affinity >= THRESHOLDS.crush.affinity &&
    s.trust >= THRESHOLDS.crush.trust
  );
}

export function canBecomeLovers(s: RelationshipState): boolean {
  return (
    (s.stage === 'close' || s.stage === 'crush') &&
    s.affinity >= THRESHOLDS.lover.affinity &&
    s.trust >= THRESHOLDS.lover.trust
  );
}

/** 套用一次回覆的變化：限制幅度、依升溫速度調整正向的好感變化 */
export function applyDeltas(
  s: RelationshipState,
  d: { affinity?: number; trust?: number; event?: RelationshipEventType | null },
  warmUp: 'slow' | 'medium' | 'fast' = 'medium',
): RelationshipState {
  const factor = { slow: 0.6, medium: 1, fast: 1.4 }[warmUp];
  let da = clamp(Math.round(d.affinity ?? 0), -MAX_DELTA, MAX_DELTA);
  if (da > 0) da = Math.max(1, Math.round(da * factor));
  const dt = clamp(Math.round(d.trust ?? 0), -MAX_DELTA, MAX_DELTA);
  // 事件本身也會影響數值
  const bonus: Partial<Record<RelationshipEventType, [number, number]>> = {
    confession_accepted: [5, 5],
    mutual_feelings: [3, 2],
    confession_rejected: [-2, 0],
    conflict: [-5, -3],
    reconciled: [4, 3],
    breakup: [-15, -10],
  };
  const [ba, bt] = (d.event && bonus[d.event]) || [0, 0];
  const affinity = clamp(s.affinity + da + ba, -100, 100);
  const trust = clamp(s.trust + dt + bt, 0, 100);
  return { affinity, trust, stage: nextStage(s.stage, affinity, trust, d.event) };
}

/** 給 avatar 的提示：以目前的關係，哪些發展是可能的 */
export function romanceGuidance(s: RelationshipState): string {
  if (s.stage === 'lover') return '你們正在交往。';
  if (canBecomeLovers(s)) {
    return '如果對方告白、而你也有感覺，你可以接受（回報 relationship_event: confession_accepted）；也可以依你的個性選擇不接受。';
  }
  if (canHaveCrush(s)) {
    return '你對對方有好感了。如果你們之間開始曖昧、彼此都有感覺，可以回報 relationship_event: mutual_feelings。對方現在告白的話，你會覺得有點太快。';
  }
  return '以你們目前的關係，對方如果告白，你會覺得太突然而拒絕或閃避（回報 relationship_event: confession_rejected）。';
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
}

export const resetRelationshipSchema = z.object({ stage: z.enum(INITIAL_STAGES) });
