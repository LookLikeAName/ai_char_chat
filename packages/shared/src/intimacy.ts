// 親密的尺度：開啟成人內容時，由程式依關係、好感與信任、avatar 對性的開放程度、心情決定「現在最多到哪裡」，
// 只把那一層的說明放給 LLM。超過的部分要它依個性婉拒或帶過；它也隨時可以拒絕或喊停。
import type { Mood, RelationshipState, Stage } from './relationship.ts';

export const INTIMACY_LEVELS = ['none', 'flirt', 'touch', 'explicit'] as const;
export type IntimacyLevel = (typeof INTIMACY_LEVELS)[number];

export const INTIMACY_LABELS: Record<IntimacyLevel, string> = {
  none: '不碰',
  flirt: '調情、暗示',
  touch: '親密接觸',
  explicit: '露骨',
};

/** 每個階段原本的尺度（0～3） */
const STAGE_BASE: Record<Stage, number> = {
  stranger: 0,
  acquaintance: 0,
  friend: 1,
  close: 1,
  bestie: 1,
  crush: 2,
  lover: 3,
  ex: 1,
  fwb: 3,
  cold: 0,
  estranged: 0,
};

export interface IntimacyInput {
  relationship: RelationshipState;
  /** avatar 對性的開放程度 0～100；沒填時 50 */
  openness?: number;
  mood?: Mood;
  /** 玩家對戀愛的態度；只想當朋友時，除了炮友以外最多到調情 */
  romancePref?: 'none' | 'slow' | 'open' | 'eager' | null;
  /** 群組裡大家都看得到：最多到調情 */
  inGroup?: boolean;
}

/** 現在最多到哪一層（純函式） */
export function intimacyLevel(i: IntimacyInput): IntimacyLevel {
  const r = i.relationship;
  const openness = i.openness ?? 50;
  let level = STAGE_BASE[r.stage];
  // 很開放的人：認識之後就會開玩笑，朋友之間也可能更進一步；很保守的人：降一層
  if (openness >= 75 && !['stranger', 'cold', 'estranged'].includes(r.stage)) level++;
  if (openness <= 25) level--;
  // 很喜歡對方（還沒在一起）：朋友之間也會想靠近一點
  if (['friend', 'close', 'bestie', 'ex'].includes(r.stage) && (r.romance ?? 0) >= 55) level++;
  level = Math.max(0, Math.min(3, level));
  // 數值門檻：沒有好感不會調情；親密接觸要有好感與信任；露骨要更信任
  if (r.affinity < 20) level = 0;
  if (level >= 2 && (r.affinity < 40 || r.trust < 30)) level = 1;
  if (level >= 3 && r.trust < 40) level = 2;
  // 心情很差時沒有那個興致
  if (i.mood && i.mood.valence <= -3) level = Math.max(0, level - 1);
  if (i.romancePref === 'none' && r.stage !== 'fwb') level = Math.min(level, 1);
  if (i.inGroup) level = Math.min(level, 1);
  return INTIMACY_LEVELS[level]!;
}

/** 給 LLM 的說明：這一層可以做什麼、不做什麼 */
export const INTIMACY_GUIDANCE: Record<IntimacyLevel, string> = {
  none: '你們現在的關係還不到可以聊性或親密的話題：對方往這個方向帶時，依你的個性婉拒、帶過、吐槽或表達不舒服。',
  flirt: '可以調情、開曖昧的玩笑、帶點暗示，但不描寫身體接觸或性；對方想再進一步時，你會打住、害羞帶過或轉移話題。',
  touch: '可以有擁抱、親吻、撫摸這類親密的互動與含蓄的描寫，但不寫露骨的性愛細節；再進一步時，依氣氛「拉燈」帶過。',
  explicit: '可以有露骨的性愛互動與描寫，用符合你個性和說話方式的方式表達、主動或被動依你的個性；仍然可以依當下的心情、氣氛或身體狀況拒絕或喊停。',
};

/** 只有開啟成人內容時才有「炮友」：關閉時當作好友（prompt、選單都看不到） */
export function visibleStage(stage: Stage, adultContent: boolean): Stage {
  return !adultContent && stage === 'fwb' ? 'close' : stage;
}
