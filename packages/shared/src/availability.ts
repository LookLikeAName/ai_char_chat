// 擬真時間：avatar 現在能不能看手機、多久才會看到訊息、要不要主動找玩家聊天。全部是純函式，時間與亂數由呼叫端提供。
import { currentBlock, type PersonaDraft, type ScheduleBlock } from './persona.ts';
import type { Stage } from './relationship.ts';

export type AvailabilityStatus = 'free' | 'busy' | 'sleep';

export interface Availability {
  status: AvailabilityStatus;
  activity: string;
  /** 目前這個狀態到什麼時候（沒有作息表時為 null） */
  until: Date | null;
}

export const STATUS_LABELS: Record<AvailabilityStatus, string> = { free: '在線', busy: '忙碌中', sleep: '睡覺中' };

/** 某時區的「現在」：是否週末、HH:MM、當地日期（YYYY-MM-DD） */
export function localClock(now: Date, timezone: string): { weekend: boolean; hhmm: string; date: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    weekend: ['Sat', 'Sun'].includes(get('weekday')),
    hhmm: `${get('hour')}:${get('minute')}`,
    date: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};

/** 從 HH:MM 到某個 HH:MM 還有幾分鐘（跨午夜會繞一圈） */
function minutesUntil(fromHHMM: string, toHHMM: string): number {
  const d = (toMinutes(toHHMM) - toMinutes(fromHHMM) + 1440) % 1440;
  return d === 0 ? 1440 : d;
}

export function availabilityAt(persona: PersonaDraft, now: Date, timezone: string): Availability {
  const schedule = persona.routine?.schedule;
  if (!schedule) return { status: 'free', activity: '', until: null };
  const clock = localClock(now, timezone);
  const block: ScheduleBlock | null = currentBlock(schedule, clock.weekend, clock.hhmm);
  // 作息表沒涵蓋的時段當作空閒
  if (!block) return { status: 'free', activity: '', until: null };
  return {
    status: block.status,
    activity: block.activity,
    until: new Date(now.getTime() + minutesUntil(clock.hhmm, block.end) * 60_000),
  };
}

/** HH:MM 是否落在 [start, end)；可以跨午夜 */
export function inTimeRange(hhmm: string, start: string, end: string): boolean {
  const t = toMinutes(hhmm);
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s === e) return false;
  return s < e ? t >= s && t < e : t >= s || t < e;
}

// ---------- 多久會看到訊息 ----------

export type ReplyPacing = 'realistic' | 'relaxed' | 'instant';

export const PACING_LABELS: Record<ReplyPacing, string> = {
  realistic: '擬真：依作息，忙碌或睡覺時可能很久才回',
  relaxed: '輕鬆：延遲縮短，最久約 15 分鐘',
  instant: '即時：幾秒內就回（測試用）',
};

export type SeenReason = 'normal' | 'peek' | 'late' | 'interrupted' | 'woken';

export const SEEN_REASON_LABELS: Record<SeenReason, string> = {
  normal: '一般',
  peek: '偷看手機',
  late: '忙完／起床才看',
  interrupted: '被催促打斷',
  woken: '被吵醒',
};

export interface SeenPlan {
  /** 什麼時候「看到」訊息 */
  at: Date;
  reason: SeenReason;
}

type Random = () => number;

const SEC = 1000;
const MIN = 60 * SEC;

/** 在 [lo, hi] 之間取一個偏向低值的亂數（真人多半很快，偶爾很久） */
function skewed(lo: number, hi: number, random: Random): number {
  const r = random();
  return lo + (hi - lo) * r * r;
}

/** 這些字眼表示玩家很急，壓力加倍 */
const URGENT = /急|快點|在嗎|回我|拜託|救命|怎麼辦|！！|!!|？？|\?\?/;

export function urgencyWeight(text: string): number {
  return URGENT.test(text) ? 2 : 1;
}

export interface SeenInput {
  availability: Availability;
  replyHabit?: 'instant' | 'normal' | 'slow';
  pacing: ReplyPacing;
  /** 還沒被看到的玩家訊息（含剛送出的這則） */
  unseen: { content: string }[];
  now: Date;
  random: Random;
}

/** 忙碌、睡覺時，累積多少壓力會讓 avatar 提早看手機 */
export const PRESSURE_THRESHOLD: Record<'busy' | 'sleep', number> = { busy: 3, sleep: 6 };

export function planSeen(input: SeenInput): SeenPlan {
  const { availability: a, pacing, now, random } = input;
  const habit = { instant: 0.3, normal: 1, slow: 3 }[input.replyHabit ?? 'normal'];
  const at = (ms: number) => new Date(now.getTime() + ms);

  if (pacing === 'instant') return { at: at(1200 + random() * 1300), reason: 'normal' };

  const pressure = input.unseen.reduce((s, m) => s + urgencyWeight(m.content), 0);
  // 回訊息很慢的人比較不容易被催動
  const threshold = (status: 'busy' | 'sleep') => PRESSURE_THRESHOLD[status] * (habit > 1 ? 1.5 : habit < 1 ? 0.7 : 1);

  let plan: SeenPlan;
  if (a.status === 'free' || !a.until) {
    plan = { at: at(skewed(5 * SEC, 2 * MIN, random) * habit), reason: 'normal' };
  } else if (a.status === 'busy') {
    if (pressure >= threshold('busy')) {
      plan = { at: at(skewed(30 * SEC, 4 * MIN, random)), reason: 'interrupted' };
    } else if (random() < 0.25) {
      // 偶爾偷看手機
      plan = { at: at(skewed(1 * MIN, 10 * MIN, random)), reason: 'peek' };
    } else {
      const untilFree = a.until.getTime() - now.getTime();
      const wait = Math.min(skewed(10 * MIN, 2 * 60 * MIN, random) * habit, untilFree + skewed(0, 10 * MIN, random));
      plan = { at: at(Math.max(wait, 1 * MIN)), reason: 'late' };
    }
  } else {
    if (pressure >= threshold('sleep')) {
      plan = { at: at(skewed(1 * MIN, 8 * MIN, random)), reason: 'woken' };
    } else {
      const wake = a.until.getTime() - now.getTime();
      plan = { at: at(wake + skewed(2 * MIN, 25 * MIN, random)), reason: 'late' };
    }
  }

  if (pacing === 'relaxed') {
    const delay = plan.at.getTime() - now.getTime();
    plan = { ...plan, at: at(Math.min(delay / 4, 15 * MIN)) };
  }
  return plan;
}

// ---------- 主動發話 ----------

const STAGE_FACTOR: Record<Stage, number> = {
  stranger: 0.15,
  acquaintance: 0.5,
  friend: 1,
  close: 1.3,
  bestie: 1.5,
  crush: 1.6,
  lover: 2,
  ex: 0.3,
  cold: 0.15,
  estranged: 0,
};

export interface ProactiveInput {
  availability: Availability;
  stage: Stage;
  /** 0～100；沒有人格設定時用 50 */
  extraversion: number;
  /** 距離這個對話最後一則訊息多久（毫秒）；沒有任何訊息時為 null */
  sinceLastMessageMs: number | null;
  /** 心動 0～100：越喜歡對方越常主動找對方（最多兩倍） */
  romance?: number;
}

/** 每 15 分鐘檢查一次時，這一次主動傳訊息的機率 */
export function proactiveChance(i: ProactiveInput): number {
  if (i.availability.status === 'sleep') return 0;
  const base = 0.03;
  const personality = 0.5 + i.extraversion / 100;
  const h = i.sinceLastMessageMs === null ? 24 : i.sinceLastMessageMs / 3_600_000;
  // 剛聊完不會馬上又找你；很久沒聊會比較想找你
  const silence = h < 1 ? 0 : h < 4 ? 0.8 : h < 24 ? 1.5 : 2;
  const status = i.availability.status === 'busy' ? 0.3 : 1;
  const romance = 1 + Math.min(100, Math.max(0, i.romance ?? 0)) / 100;
  return Math.min(0.5, base * personality * STAGE_FACTOR[i.stage] * romance * silence * status);
}

// ---------- 生活日誌 ----------

export interface LifeLogEvent {
  /** HH:MM */
  time: string;
  text: string;
}

/** 到某個時間為止已經發生的事 */
export function eventsSoFar(events: LifeLogEvent[], hhmm: string): LifeLogEvent[] {
  return events.filter((e) => e.time <= hhmm).sort((a, b) => a.time.localeCompare(b.time));
}
