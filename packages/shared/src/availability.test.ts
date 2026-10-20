import { describe, expect, it } from 'vitest';
import { availabilityAt, inTimeRange, localClock, planSeen, proactiveChance, urgencyWeight } from './availability.ts';

const persona = {
  routine: {
    schedule: {
      weekday: [
        { start: '00:30', end: '07:30', activity: '睡覺', status: 'sleep' as const },
        { start: '09:00', end: '19:00', activity: '顧店', status: 'busy' as const },
        { start: '19:00', end: '00:30', activity: '在家放空', status: 'free' as const },
      ],
      weekend: [{ start: '00:00', end: '00:00', activity: '?', status: 'free' as const }],
    },
  },
};
const TZ = 'Asia/Taipei';
// 2026-10-19 是週一；台北 = UTC+8
const taipei = (hhmm: string) => new Date(`2026-10-19T${hhmm}:00+08:00`);

describe('availabilityAt', () => {
  it('依作息推算狀態與結束時間', () => {
    const busy = availabilityAt(persona, taipei('10:00'), TZ);
    expect(busy).toMatchObject({ status: 'busy', activity: '顧店' });
    expect(busy.until?.toISOString()).toBe(taipei('19:00').toISOString());
    const sleep = availabilityAt(persona, taipei('03:00'), TZ);
    expect(sleep.status).toBe('sleep');
    expect(sleep.until?.toISOString()).toBe(taipei('07:30').toISOString());
  });
  it('跨午夜的區段算到隔天', () => {
    const a = availabilityAt(persona, taipei('23:00'), TZ);
    expect(a.status).toBe('free');
    expect(a.until?.toISOString()).toBe(new Date('2026-10-20T00:30:00+08:00').toISOString());
  });
  it('作息沒涵蓋的時段、沒有人格設定時都是空閒', () => {
    expect(availabilityAt(persona, taipei('08:00'), TZ)).toEqual({ status: 'free', activity: '', until: null });
    expect(availabilityAt({}, taipei('03:00'), TZ).status).toBe('free');
  });
  it('localClock 回傳當地日期', () => {
    expect(localClock(new Date('2026-10-19T17:00:00Z'), TZ)).toEqual({ weekend: false, hhmm: '01:00', date: '2026-10-20' });
  });
});

describe('inTimeRange', () => {
  it('支援跨午夜的區間', () => {
    expect(inTimeRange('01:00', '00:30', '08:00')).toBe(true);
    expect(inTimeRange('23:59', '23:00', '07:00')).toBe(true);
    expect(inTimeRange('12:00', '23:00', '07:00')).toBe(false);
  });
});

describe('planSeen', () => {
  const now = taipei('10:00');
  const base = { replyHabit: 'normal' as const, pacing: 'realistic' as const, now };
  const minutes = (p: { at: Date }) => (p.at.getTime() - now.getTime()) / 60_000;

  it('空閒時幾秒到兩分鐘內就看到', () => {
    const free = { status: 'free' as const, activity: '', until: null };
    const p = planSeen({ ...base, availability: free, unseen: [{ content: '嗨' }], random: () => 0.9 });
    expect(p.reason).toBe('normal');
    expect(minutes(p)).toBeLessThanOrEqual(2);
  });

  it('忙碌時不會偷看就等到有空，但不超過兩小時', () => {
    const busy = availabilityAt(persona, now, TZ);
    const p = planSeen({ ...base, availability: busy, unseen: [{ content: '嗨' }], random: () => 0.9 });
    expect(p.reason).toBe('late');
    expect(minutes(p)).toBeGreaterThan(10);
    expect(minutes(p)).toBeLessThanOrEqual(120);
  });

  it('忙碌時連續傳訊息會讓他提早看', () => {
    const busy = availabilityAt(persona, now, TZ);
    const p = planSeen({
      ...base,
      availability: busy,
      unseen: [{ content: '欸' }, { content: '在嗎' }],
      random: () => 0.9,
    });
    // 「在嗎」權重 2 + 1 = 3，達到忙碌的門檻
    expect(p.reason).toBe('interrupted');
    expect(minutes(p)).toBeLessThan(5);
  });

  it('睡覺時要到起床後才看到，除非被吵醒', () => {
    const at3 = taipei('03:00');
    const sleep = availabilityAt(persona, at3, TZ);
    const late = planSeen({ ...base, now: at3, availability: sleep, unseen: [{ content: '晚安' }], random: () => 0.5 });
    expect(late.reason).toBe('late');
    expect(late.at.getTime()).toBeGreaterThan(taipei('07:30').getTime());
    const woken = planSeen({
      ...base,
      now: at3,
      availability: sleep,
      unseen: [{ content: '救命' }, { content: '快點回我' }, { content: '！！' }],
      random: () => 0.5,
    });
    expect(woken.reason).toBe('woken');
  });

  it('輕鬆模式最多 15 分鐘；即時模式幾秒', () => {
    const at3 = taipei('03:00');
    const sleep = availabilityAt(persona, at3, TZ);
    const relaxed = planSeen({ ...base, pacing: 'relaxed', now: at3, availability: sleep, unseen: [{ content: '嗨' }], random: () => 0.5 });
    expect((relaxed.at.getTime() - at3.getTime()) / 60_000).toBeLessThanOrEqual(15);
    const instant = planSeen({ ...base, pacing: 'instant', now: at3, availability: sleep, unseen: [{ content: '嗨' }], random: () => 0.5 });
    expect(instant.at.getTime() - at3.getTime()).toBeLessThan(3000);
  });

  it('urgencyWeight', () => {
    expect(urgencyWeight('在嗎')).toBe(2);
    expect(urgencyWeight('今天天氣不錯')).toBe(1);
  });
});

describe('proactiveChance', () => {
  const free = { status: 'free' as const, activity: '', until: null };
  it('睡覺、剛聊完、疏遠時不會主動', () => {
    expect(proactiveChance({ availability: { ...free, status: 'sleep' }, stage: 'lover', extraversion: 90, sinceLastMessageMs: 1e8 })).toBe(0);
    expect(proactiveChance({ availability: free, stage: 'lover', extraversion: 90, sinceLastMessageMs: 10 * 60_000 })).toBe(0);
    expect(proactiveChance({ availability: free, stage: 'estranged', extraversion: 90, sinceLastMessageMs: 1e8 })).toBe(0);
  });
  it('關係越近、越外向、越久沒聊，機率越高', () => {
    const p = (stage: 'friend' | 'lover', e: number, h: number) =>
      proactiveChance({ availability: free, stage, extraversion: e, sinceLastMessageMs: h * 3_600_000 });
    expect(p('lover', 50, 5)).toBeGreaterThan(p('friend', 50, 5));
    expect(p('friend', 90, 5)).toBeGreaterThan(p('friend', 10, 5));
    expect(p('friend', 50, 30)).toBeGreaterThan(p('friend', 50, 5));
  });
  it('越心動越常主動找對方（最多兩倍）', () => {
    const p = (romance: number) => proactiveChance({ availability: free, stage: 'friend', extraversion: 50, sinceLastMessageMs: 5 * 3_600_000, romance });
    expect(p(50)).toBeCloseTo(p(0) * 1.5);
    expect(p(300)).toBeCloseTo(p(0) * 2);
  });
});
