import { describe, expect, it } from 'vitest';
import { applyDeltas, canBecomeLovers, decayMood, nextStage, romanceGuidance } from './relationship.ts';

describe('nextStage：友誼的階梯', () => {
  it('依門檻升階', () => {
    expect(nextStage('stranger', 5, 10)).toBe('stranger');
    expect(nextStage('stranger', 12, 10)).toBe('acquaintance');
    expect(nextStage('acquaintance', 31, 26)).toBe('friend');
    expect(nextStage('friend', 56, 51)).toBe('close');
  });
  it('信任不夠就不會升階', () => {
    expect(nextStage('acquaintance', 40, 10)).toBe('acquaintance');
  });
  it('降階有緩衝，且認識後不會回到陌生', () => {
    expect(nextStage('friend', 25, 20)).toBe('friend');
    expect(nextStage('friend', 18, 20)).toBe('acquaintance');
    expect(nextStage('acquaintance', 0, 0)).toBe('acquaintance');
  });
  it('好感太低變冷淡或疏遠，回升後恢復', () => {
    expect(nextStage('friend', -25, 20)).toBe('cold');
    expect(nextStage('cold', -55, 0)).toBe('estranged');
    expect(nextStage('cold', -5, 0)).toBe('cold');
    expect(nextStage('cold', 12, 10)).toBe('acquaintance');
  });
});

describe('nextStage：戀愛需要事件 + 數值', () => {
  it('數值不夠時告白事件不會升級', () => {
    expect(nextStage('friend', 40, 30, 'confession_accepted')).toBe('friend');
  });
  it('好友或曖昧、數值夠時接受告白 → 戀人', () => {
    expect(nextStage('close', 62, 50, 'confession_accepted')).toBe('lover');
    expect(nextStage('crush', 61, 46, 'confession_accepted')).toBe('lover');
  });
  it('朋友以上、好感夠 → 曖昧', () => {
    expect(nextStage('friend', 46, 31, 'mutual_feelings')).toBe('crush');
    expect(nextStage('acquaintance', 46, 31, 'mutual_feelings')).toBe('friend');
  });
  it('戀人不會因小波動降級，分手才會', () => {
    expect(nextStage('lover', 30, 40)).toBe('lover');
    expect(nextStage('lover', 40, 40, 'breakup')).toBe('friend');
    expect(nextStage('lover', 5, 40)).toBe('cold');
  });
});

describe('applyDeltas', () => {
  it('每次最多 ±3，慢熱的人好感漲得比較慢', () => {
    const s = { stage: 'acquaintance' as const, affinity: 20, trust: 20 };
    expect(applyDeltas(s, { affinity: 10, trust: -9 })).toMatchObject({ affinity: 23, trust: 17 });
    expect(applyDeltas(s, { affinity: 3 }, 'slow').affinity).toBe(22);
    expect(applyDeltas(s, { affinity: 3 }, 'fast').affinity).toBe(24);
    expect(applyDeltas(s, { affinity: -3 }, 'slow').affinity).toBe(17);
  });
  it('事件帶來額外的變化並改變階段', () => {
    const s = { stage: 'close' as const, affinity: 58, trust: 50 };
    expect(canBecomeLovers(s)).toBe(false);
    const r = applyDeltas(s, { affinity: 2, event: 'confession_accepted' });
    // 58 + 2 + 5 = 65 → 符合門檻
    expect(r).toEqual({ affinity: 65, trust: 55, stage: 'lover' });
  });
});

describe('romanceGuidance', () => {
  it('依關係給出不同的提示', () => {
    expect(romanceGuidance({ stage: 'friend', affinity: 20, trust: 20 })).toContain('太突然');
    expect(romanceGuidance({ stage: 'friend', affinity: 50, trust: 40 })).toContain('mutual_feelings');
    expect(romanceGuidance({ stage: 'close', affinity: 70, trust: 60 })).toContain('confession_accepted');
  });
});

describe('decayMood', () => {
  it('隨時間回到平常', () => {
    const t0 = new Date('2026-10-19T00:00:00Z');
    const m = { label: '超開心', valence: 4, energy: -4 };
    expect(decayMood(m, t0, t0)).toEqual(m);
    expect(decayMood(m, t0, new Date('2026-10-19T08:00:00Z'))).toEqual({ label: '超開心', valence: 2, energy: -2 });
    expect(decayMood(m, t0, new Date('2026-10-20T12:00:00Z'))).toEqual({ label: '平常', valence: 0, energy: 0 });
  });
});
