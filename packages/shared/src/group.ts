// 群組聊天：玩家發話後，決定這一輪誰回、照什麼順序。純規則，不呼叫 LLM。
import type { AvailabilityStatus } from './availability.ts';

export interface SpeakerCandidate {
  id: string;
  name: string;
  status: AvailabilityStatus;
  /** 0～100 */
  extraversion: number;
  /** 對玩家的好感 -100～100 */
  affinity: number;
  /** 0～1：玩家的訊息和它的興趣、愛聊的話題有多相關 */
  relevance: number;
  /** 最近 10 則訊息裡它講了幾則 */
  recentMessages: number;
  /** 被點名 */
  mentioned: boolean;
}

export interface ScoredCandidate extends SpeakerCandidate {
  score: number;
  chosen: boolean;
  why: string;
}

/** 一輪最多幾則 avatar 訊息（所有人加起來） */
export const GROUP_MESSAGE_BUDGET = 4;
const MAX_SPEAKERS = 3;
const THRESHOLD = 0.32;
/** 玩家在問大家時，每個人都比較想回 */
const EVERYONE_BONUS = 0.1;
const STATUS_FACTOR: Record<AvailabilityStatus, number> = { free: 1, busy: 0.4, sleep: 0 };

/** 玩家在問問題、或對大家說話：至少要有一個人回 */
export function addressesEveryone(text: string): boolean {
  return /[?？]|大家|你們|各位|有人|誰/.test(text);
}

/** 訊息裡有沒有點名這個人：「@名字」或直接叫名字（兩個字以上的名字才算，避免誤判） */
export function mentions(text: string, name: string): boolean {
  if (!name) return false;
  if (text.includes(`@${name}`)) return true;
  return [...name].length >= 2 && text.includes(name);
}

export function chooseSpeakers(
  candidates: SpeakerCandidate[],
  /** forceOne：玩家在問大家，至少一個人回、而且每個人都比較會回 */
  opts: { random: () => number; forceOne: boolean; maxSpeakers?: number },
): ScoredCandidate[] {
  const max = Math.min(opts.maxSpeakers ?? MAX_SPEAKERS, MAX_SPEAKERS);
  const scored: ScoredCandidate[] = candidates.map((c) => {
    if (c.status === 'sleep') return { ...c, score: 0, chosen: false, why: '睡覺中' };
    if (c.mentioned) return { ...c, score: 10, chosen: false, why: '被點名' };
    const base =
      0.35 * c.relevance +
      0.25 * (c.extraversion / 100) +
      0.25 * Math.max(0, Math.min(1, (c.affinity + 20) / 100)) +
      0.15 * opts.random() -
      0.08 * c.recentMessages +
      (opts.forceOne ? EVERYONE_BONUS : 0);
    return { ...c, score: Math.max(0, base * STATUS_FACTOR[c.status]), chosen: false, why: '' };
  });

  const order = [...scored].sort((a, b) => b.score - a.score);
  let picked = 0;
  for (const c of order) {
    if (picked >= max) break;
    if (c.mentioned && c.status !== 'sleep') {
      c.chosen = true;
      picked++;
    } else if (c.score >= THRESHOLD) {
      c.chosen = true;
      c.why = c.why || '話題相關或想聊';
      picked++;
    }
  }
  if (!picked && opts.forceOne) {
    const top = order.find((c) => c.status !== 'sleep');
    if (top) {
      top.chosen = true;
      top.why = '玩家在問大家，至少一個人回';
    }
  }
  for (const c of scored) if (!c.chosen && !c.why) c.why = c.status === 'busy' ? '忙碌中，分數打折' : '分數不夠';
  return order;
}
